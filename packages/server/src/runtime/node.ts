import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { getRequestListener } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import type { Beamhop } from "../app";
import { makeEnv } from "../app";
import { clientIp, closeReason, graceFor, proxyMatcher, wsMaxPayload, type RunningServer, type ServeOptions } from "./common";

const PING_INTERVAL_MS = 30_000;
const header = (req: IncomingMessage) => (n: string) => {
  const v = req.headers[n];
  return Array.isArray(v) ? v[0] : v;
};

/** node:http + `ws` adapter. Also works under Bun (used in tests), but Bun prefers serveBun. */
export async function serveNode(beamhop: Beamhop, opts: ServeOptions = {}): Promise<RunningServer> {
  const { config, relay, settings, logger } = beamhop;
  const log = logger.child("http");
  const trustProxy = config.server.trustProxy;
  const proxyIpHeader = config.server.proxyIpHeader;
  const trustedProxies = proxyMatcher(config.server.trustedProxies);

  const listener = getRequestListener(
    (req, env) => {
      const incoming = (env as { incoming: IncomingMessage }).incoming;
      const ip = clientIp(incoming.socket.remoteAddress, header(incoming), trustProxy, proxyIpHeader, trustedProxies);
      return beamhop.fetch(req, makeEnv(ip, env as unknown as Record<string, unknown>));
    },
    {
      errorHandler: (err) => {
        log.error("request failed", { error: (err as Error)?.message });
        return new Response("internal server error", { status: 500 });
      },
    },
  );
  const server = createServer(listener);
  // slowloris: headers must arrive within 30s; a whole request (incl. a large upload body) within 30 min
  server.headersTimeout = 30_000;
  server.requestTimeout = 30 * 60_000;
  server.keepAliveTimeout = 65_000;

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: wsMaxPayload(settings.get().limits.maxMessageBytes),
    // no context takeover: each message is compressed on its own, so an idle connection doesn't pin a zlib window
    perMessageDeflate: { threshold: 1024, zlibDeflateOptions: { level: 3 }, concurrencyLimit: 10, serverNoContextTakeover: true, clientNoContextTakeover: true },
  });
  const unsub = settings.onChange((s) => {
    (wss.options as { maxPayload?: number }).maxPayload = wsMaxPayload(s.limits.maxMessageBytes);
  });
  const alive = new WeakMap<WebSocket, boolean>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path !== "/" || (req.headers.upgrade ?? "").toLowerCase() !== "websocket") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!beamhop.lifecycle.accepting) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nRetry-After: 5\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    const ip = clientIp(req.socket.remoteAddress, header(req), trustProxy, proxyIpHeader, trustedProxies);
    wss.handleUpgrade(req, socket, head, (ws) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      ws.on("error", (err) => log.debug("websocket error", { error: err.message }));
      let handle: ReturnType<typeof relay.handleConnection> | undefined;
      ws.on("message", (data, isBinary) => {
        alive.set(ws, true);
        const text = isBinary ? Buffer.from(data as Buffer).toString("utf8") : data.toString();
        try {
          handle?.onMessage(text);
        } catch (err) {
          // an exception in an EventEmitter listener would be uncaught: contain it to this connection
          log.error("websocket message handler failed", { error: err });
          ws.close(1011, "internal error");
        }
      });
      ws.on("close", () => {
        try {
          handle?.onClose();
        } catch (err) {
          log.error("websocket close handler failed", { error: err });
        }
        handle = undefined;
      });
      try {
        handle = relay.handleConnection(
          {
            send: (d) => {
              if (ws.readyState === ws.OPEN) ws.send(d);
            },
            close: (code, reason) => ws.close(code, closeReason(reason)),
            bufferedAmount: () => ws.bufferedAmount,
          },
          { ip, userAgent: req.headers["user-agent"], origin: req.headers.origin },
        );
      } catch (err) {
        log.error("handleConnection failed", { error: (err as Error).message });
        ws.close(1011, "internal error");
      }
    });
  });

  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {}
    }
  }, PING_INTERVAL_MS);
  pinger.unref();

  const host = opts.host ?? config.server.host;
  const port = opts.port ?? config.server.port;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  let closed = false;
  const running: RunningServer = {
    runtime: "node",
    hostname: host,
    port: boundPort,
    stopAccepting() {
      if (closed) return;
      closed = true;
      unsub();
      clearInterval(pinger);
      server.close();
      server.closeIdleConnections?.();
    },
    settle(signal) {
      // relay.stop() has started a 1001 close (after its shutdown NOTICE) on every socket: give those handshakes a
      // moment to finish, so clients see a clean close instead of 1006
      const pending = [...wss.clients].filter((ws) => ws.readyState !== ws.CLOSED);
      const closed = (ws: WebSocket) => new Promise<void>((resolve) => (ws.readyState === ws.CLOSED ? resolve() : ws.once("close", () => resolve())));
      return graceFor(pending.map(closed), undefined, signal);
    },
    async stop() {
      running.stopAccepting();
      await running.settle();
      // then cut whatever is left
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
    },
  };
  return running;
}
