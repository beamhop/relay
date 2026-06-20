import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const originalRelayPassword = process.env.RELAY_PASSWORD;

afterEach(() => {
  if (originalRelayPassword === undefined) delete process.env.RELAY_PASSWORD;
  else process.env.RELAY_PASSWORD = originalRelayPassword;
});

test("admin web mode requires a password", async () => {
  delete process.env.RELAY_PASSWORD;
  await expect(loadConfig(["--web"])).rejects.toThrow("admin web interface requires");
});

test("admin password can come from RELAY_PASSWORD and flags override it", async () => {
  process.env.RELAY_PASSWORD = "env-password";
  const envConfig = await loadConfig(["--web"]);
  expect(envConfig.admin).toEqual({ web: true, password: "env-password" });

  const flagConfig = await loadConfig(["--web", "--password", "flag-password"]);
  expect(flagConfig.admin).toEqual({ web: true, password: "flag-password" });
});

test("-w can enable web admin and receive the password value", async () => {
  delete process.env.RELAY_PASSWORD;
  const config = await loadConfig(["-w", "inline-password"]);
  expect(config.admin).toEqual({ web: true, password: "inline-password" });
});
