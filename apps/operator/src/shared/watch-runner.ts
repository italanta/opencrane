import * as k8s from "@kubernetes/client-node";
import type { Logger } from "pino";

/** Generic watch callback for CR events. */
type WatchEventHandler<T> = (type: string, resource: T) => Promise<void>;

/** Configuration for the generic watch loop runner. */
interface WatchRunnerConfig<T>
{
  /** Watch client created from KubeConfig. */
  watch: k8s.Watch;

  /** Absolute API path to watch. */
  path: string;

  /** Scoped logger for watch lifecycle logs. */
  log: Logger;

  /** Message logged before establishing the watch stream. */
  startMessage: string;

  /** Message logged when the stream drops and reconnect will happen. */
  reconnectMessage: string;

  /** Message logged when watch setup fails and retry will happen. */
  failedMessage: string;

  /** Domain-specific event handler for watched resources. */
  onEvent: WatchEventHandler<T>;

  /** Delay before reconnect retry in milliseconds. */
  retryDelayMs?: number;
}

/**
 * Runs a resilient Kubernetes watch loop with automatic reconnects.
 *
 * ## What is a Kubernetes watch loop?
 *
 * The Kubernetes API server supports a `?watch=true` query parameter on list
 * endpoints. Instead of returning a snapshot and closing, it holds the HTTP
 * connection open and streams newline-delimited JSON events as resources
 * change. Each event has a `type` ("ADDED", "MODIFIED", "DELETED") and the
 * full resource body. This is how controllers react to changes in real time
 * without polling.
 *
 * ## Why does it need reconnects?
 *
 * The watch stream is not permanent. The API server closes it after a
 * server-defined timeout (typically 5–10 minutes, controlled by
 * `--min-request-timeout`). Network interruptions, pod restarts, and API
 * server upgrades also drop the connection. A production operator must detect
 * the closed stream and re-establish it immediately, otherwise it silently
 * stops receiving events and diverges from the desired state of the cluster.
 *
 * ## What this function does
 *
 * 1. Opens a watch stream against the given API `path`.
 * 2. Forwards each incoming event to the caller's `onEvent` handler.
 * 3. When the stream closes normally (no error), schedules a reconnect after
 *    `retryDelayMs` milliseconds — the normal end-of-watch-window case.
 * 4. When the stream closes with an error, logs the error and schedules the
 *    same reconnect — the network-failure case.
 * 5. When watch setup itself throws (CRD not yet registered, RBAC denied,
 *    etc.), logs and retries with the same backoff.
 *
 * The result is a self-healing loop: the caller just awaits this function and
 * relies on `onEvent` being called indefinitely, regardless of transient
 * cluster disruptions.
 */
export async function _RunWatchLoop<T>(config: WatchRunnerConfig<T>): Promise<void>
{
  const retryDelayMs = config.retryDelayMs ?? 5000;

  config.log.info({ path: config.path }, config.startMessage);

  const watchLoop = async () => {
    try
    {
      await config.watch.watch(
        config.path,
        {},
        (type: string, resource: T) => {
          config.onEvent(type, resource).catch((err) => {
            config.log.error({ err }, "event handler failed");
          });
        },
        (err) => {
          if (err)
          {
            config.log.error({ err }, config.reconnectMessage);
          }
          setTimeout(watchLoop, retryDelayMs);
        },
      );
    }
    catch (err)
    {
      config.log.error({ err }, config.failedMessage);
      setTimeout(watchLoop, retryDelayMs);
    }
  };

  await watchLoop();
}
