import { expect, test } from "bun:test";
import { InProcessBroadcaster } from "../src/broadcaster";
import { secretKey, signedEvent } from "./helpers";

test("in-process broadcaster delivers announcements to every subscriber and awaits them", async () => {
  const broadcaster = new InProcessBroadcaster();
  const event = signedEvent(secretKey(1), { kind: 1, content: "hi" });
  const received: string[] = [];

  broadcaster.subscribe((announced) => {
    received.push(`a:${announced.id}`);
  });
  broadcaster.subscribe(async (announced) => {
    await Promise.resolve();
    received.push(`b:${announced.id}`);
  });

  await broadcaster.announce(event);

  expect(received).toEqual([`a:${event.id}`, `b:${event.id}`]);
  await broadcaster.close();
});
