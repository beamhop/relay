import { expect, test } from "bun:test";
import { ManagementState } from "../src/management";
import { createPluginManager } from "../src/plugins";
import { secretKey, signedEvent, testConfig } from "./helpers";

test("kind allowlist does not block enabled plugin event kinds", () => {
  const plugins = createPluginManager(testConfig());
  const management = new ManagementState();
  management.allowedKinds.add(54321);

  let index = 1;
  for (const kind of plugins.supportedEventKinds) {
    const event = signedEvent(secretKey((index % 250) + 1), { kind });
    expect(management.validateEvent(event, { supportedEventKinds: plugins.supportedEventKinds })).toEqual({ ok: true });
    index += 1;
  }

  const unknown = signedEvent(secretKey(251), { kind: 54322 });
  expect(management.validateEvent(unknown, { supportedEventKinds: plugins.supportedEventKinds })).toMatchObject({
    ok: false,
    prefix: "restricted",
    message: "event kind is not allowlisted",
  });
});
