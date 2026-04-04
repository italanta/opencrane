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
