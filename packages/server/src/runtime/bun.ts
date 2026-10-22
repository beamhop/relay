import type { ConnectionHandle } from "@beamhop/sdk";
import type { Beamhop } from "../app";
import { isRelayUpgrade, makeEnv } from "../app";
import { clientIp, type RunningServer, type ServeOptions } from "./common";

interface WsData {
  ip: string;
  userAgent?: string;
  origin?: string;
  handle?: ConnectionHandle;
}

const MB = 1024 * 1024;
const decoder = new TextDecoder();

/** Bun.serve adapter: HTTP via Hono + native websockets on "/" bridged to relay.handleConnection. */
export async function serveBun(beamhop: Beamhop, opts: ServeOptions = {}): Promise<RunningServer> {
  const Bun = (globalThis as unknown as { Bun: typeof import("bun") }).Bun;
  const { config, relay, settings, logger } = beamhop;
  const log = logger.child("http");
  const trustProxy = config.server.trustProxy;
  const limits = () => {
    const s = settings.get();
    return {
      maxPayloadLength: Math.max(4096, s.limits.maxMessageBytes),
      maxRequestBodySize: Math.max(128 * MB, s.blossom.maxUploadBytes + MB),
    };
  };

  const websocket: import("bun").WebSocketHandler<WsData> = {
    perMessageDeflate: true,
    idleTimeout: 120,
    sendPings: true,
    maxPayloadLength: limits().maxPayloadLength,
    backpressureLimit: 4 * MB,
    open(ws) {
      try {
        ws.data.handle = relay.handleConnection(
          {
            send: (data) => {
              if (ws.readyState === 1) ws.send(data);
            },
            close: (code, reason) => ws.close(code, reason),
            bufferedAmount: () => ws.getBufferedAmount(),
          },
          { ip: ws.data.ip, userAgent: ws.data.userAgent, origin: ws.data.origin },
        );
      } catch (err) {
        log.error("handleConnection failed", { error: (err as Error).message });
        ws.close(1011, "internal error");
      }
    },
    message(ws, msg) {
      ws.data.handle?.onMessage(typeof msg === "string" ? msg : decoder.decode(msg));
    },
    close(ws) {
      ws.data.handle?.onClose();
      ws.data.handle = undefined;
    },
  };

  const serverOptions = () => ({
    hostname: opts.host ?? config.server.host,
    port: opts.port ?? config.server.port,
    idleTimeout: 120,
    maxRequestBodySize: limits().maxRequestBodySize,
    development: false,
    fetch(req: Request, server: import("bun").Server<WsData>) {
      const ip = clientIp(server.requestIP(req)?.address, (n) => req.headers.get(n), trustProxy);
      if (isRelayUpgrade(req)) {
        const ok = server.upgrade(req, { data: { ip, userAgent: req.headers.get("user-agent") ?? undefined, origin: req.headers.get("origin") ?? undefined } });
        if (ok) return undefined as unknown as Response;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      return beamhop.fetch(req, makeEnv(ip, { server }));
    },
    error(err: Error) {
      log.error("request failed", { error: err.message });
      return new Response("internal server error", { status: 500 });
    },
    websocket,
  });

  const server = Bun.serve<WsData>(serverOptions() as never);
  let current = limits();
  const unsub = settings.onChange(() => {
    const next = limits();
    if (next.maxPayloadLength === current.maxPayloadLength && next.maxRequestBodySize === current.maxRequestBodySize) return;
    current = next;
    websocket.maxPayloadLength = next.maxPayloadLength;
    server.reload(serverOptions() as never);
    log.info("reloaded server limits", next);
  });

  return {
    runtime: "bun",
    hostname: server.hostname ?? config.server.host,
    port: server.port ?? config.server.port,
    stopAccepting() {
      unsub();
      void server.stop(false);
    },
    async stop() {
      unsub();
      await server.stop(true);
    },
  };
}
