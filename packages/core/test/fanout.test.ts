import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import type { NostrEvent } from "@beamhop/sdk";
import { keypair, setup, sign } from "./fakes";

describe("live fan-out", () => {
  test("every recipient gets the event under its own subscription id, with exact message.out sizes", async () => {
    const { connect, relay, bus } = await setup();
    const readers = [connect("1.1.1.1"), connect("2.2.2.2"), connect("3.3.3.3")];
    const subIds = ["plain", "ünïcödé-sub", 'quote"sub'];
    for (let i = 0; i < readers.length; i++) await readers[i].req(subIds[i], { kinds: [1], limit: 0 });
    const out: { connId: string; type: string; bytes: number }[] = [];
    bus.on("message.out", (e) => void out.push(e));
    const ev = sign(keypair(), { content: "grüße 🌍 \"quoted\" \\ back" });
    expect((await relay.publish(ev, "api")).ok).toBe(true);
    for (let i = 0; i < readers.length; i++) {
      const got = readers[i].socket.of("EVENT").find((m) => m[1] === subIds[i]);
      expect(got?.[2] as NostrEvent).toEqual(JSON.parse(JSON.stringify(ev)));
    }
    const events = out.filter((e) => e.type === "EVENT");
    expect(events.map((e) => e.bytes).sort()).toEqual(subIds.map((id) => Buffer.byteLength(JSON.stringify(["EVENT", id, ev]))).sort());
  });
});
