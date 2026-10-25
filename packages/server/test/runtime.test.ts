import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createBeamhop, type Beamhop } from "../src/app";
import { serve, type RunningServer } from "../src/server";
import { stubFactories, testConfig } from "./stubs";

function wsRoundtrip(url: string, headers?: Record<string, string>): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers } as never);
    const got: string[] = [];
    const t = setTimeout(() => reject(new Error("timeout")), 3000);
    ws.onmessage = (m) => {
      got.push(String(m.data));
      if (got.length === 1) ws.send('["REQ","x",{}]');
      else {
        clearTimeout(t);
        ws.close();
        resolve(got);
      }
    };
    ws.onerror = () => reject(new Error("ws error"));
  });
}

// @hono/node-server swaps in its own global Request/Response; Bun.serve in later test files needs the native ones
const { Request: NativeRequest, Response: NativeResponse } = globalThis;
afterAll(() => {
  Object.defineProperty(globalThis, "Request", { value: NativeRequest });
  Object.defineProperty(globalThis, "Response", { value: NativeResponse });
});

for (const runtime of ["bun", "node"] as const) {
  describe(`${runtime} runtime adapter`, () => {
    let bh: Beamhop;
    let server: RunningServer;
    let base: string;
    beforeAll(async () => {
      bh = await createBeamhop(testConfig({ server: { host: "127.0.0.1", port: 0, trustProxy: runtime === "node" } }), { factories: stubFactories() });
      await bh.start();
      server = await serve(bh, { runtime, port: 0, host: "127.0.0.1" });
      base = `127.0.0.1:${server.port}`;
    });
    afterAll(async () => {
      server.stopAccepting();
      await bh.stop();
      await server.stop();
    });

    test("websocket on / reaches relay.handleConnection with client ip", async () => {
      const msgs = await wsRoundtrip(`ws://${base}/`, runtime === "node" ? { "x-forwarded-for": "6.6.6.6, 198.51.100.7" } : undefined);
      expect(JSON.parse(msgs[0])).toEqual(["NOTICE", runtime === "node" ? "hello 198.51.100.7" : "hello 127.0.0.1"]);
      expect(JSON.parse(msgs[1])).toEqual(["ECHO", '["REQ","x",{}]']);
    });

    test("http: NIP-11, landing, admin api ip", async () => {
      const nip11 = await fetch(`http://${base}/`, { headers: { accept: "application/nostr+json" } });
      expect((await nip11.json()).name).toBe("stub");
      expect(await (await fetch(`http://${base}/`)).text()).toContain("<!doctype html>");
      const me = await (await fetch(`http://${base}/admin/api/me`, { headers: { "x-forwarded-for": "203.0.113.5" } })).json();
      expect(me.ip).toBe(runtime === "node" ? "203.0.113.5" : "127.0.0.1");
    });

    test("upload bodies pass through", async () => {
      const res = await fetch(`http://${base}/upload`, { method: "PUT", body: new Uint8Array(1024 * 1024) });
      expect(res.status).toBe(200);
    });
  });
}
