// OpenTelemetry must initialise before any instrumented module is imported.
import "./instrument.js";

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import httpProxy from "http-proxy";

import { ___BindConsole, ___CreateLogger, ___ShutdownTelemetry } from "@opencrane/observability";

import { _LoadConfig } from "./config.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { _HandleUpgrade } from "./proxy.js";
import type { WsProxy } from "./proxy.js";

/** Root logger for the gateway proxy — structured JSON, trace-correlated. */
const log = ___CreateLogger("gateway-proxy");

// Route any stray console.* output through the structured logger.
const _unbindConsole = ___BindConsole(log);

function main(): void
{
  const config = _LoadConfig();

  if (config.allowedOrigins.length === 0)
  {
    // Fail closed but loud: with no allowlist every browser upgrade is refused.
    log.warn("ALLOWED_ORIGINS is empty — every gateway WS upgrade will be refused (CSWSH fail-closed). Set the org host(s).");
  }

  // The reverse proxy. `ws:true` enables WebSocket forwarding; no path rewriting —
  // the gateway path is preserved verbatim to the upstream pod.
  const proxy = httpProxy.createProxyServer({ ws: true });
  proxy.on("error", function _onError(err) { log.error({ err }, "http-proxy emitted an error"); });

  const limiter = new FixedWindowRateLimiter(config.rateLimitPerMinute);
  const deps = { config, proxy: proxy as unknown as WsProxy, limiter, log };

  // Plain HTTP server: serves only liveness/readiness probes. All real traffic is
  // the WS upgrade, handled below.
  const server = createServer(function _onRequest(req: IncomingMessage, res: ServerResponse)
  {
    if (req.url === "/healthz" || req.url === "/readyz")
    {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });

  // The only meaningful path: authorise + route each gateway WebSocket upgrade.
  server.on("upgrade", function _onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer)
  {
    void _HandleUpgrade(deps, req, socket, head).catch(function _onHandlerError(err: unknown)
    {
      log.error({ err }, "unhandled error in gateway upgrade handler");
      if (!socket.destroyed)
      {
        socket.destroy();
      }
    });
  });

  server.listen(config.port, function _onListen()
  {
    log.info({ port: config.port, allowedOrigins: config.allowedOrigins.length, gatewayPort: config.gatewayPort }, "gateway-proxy listening");
  });

  /**
   * Drain the server, flush spans, restore console, then exit.
   * @param signal - The signal that triggered shutdown.
   */
  async function _shutdown(signal: string): Promise<void>
  {
    log.info({ signal }, "shutting down gateway-proxy");
    const hardExit = setTimeout(function _force() { process.exit(1); }, 10_000);
    hardExit.unref();
    try
    {
      await new Promise<void>(function _close(resolve) { server.close(function _done() { resolve(); }); });
      proxy.close();
      await ___ShutdownTelemetry();
    }
    finally
    {
      _unbindConsole();
      process.exit(0);
    }
  }

  process.on("SIGTERM", function _term() { void _shutdown("SIGTERM"); });
  process.on("SIGINT", function _int() { void _shutdown("SIGINT"); });
}

main();
