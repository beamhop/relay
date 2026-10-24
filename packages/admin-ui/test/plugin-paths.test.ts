import { describe, expect, test } from "bun:test";
import { PluginPathError, pluginFetchUrl, pluginRelativePath } from "../src/plugins/paths";

const BASE = "/admin/api";

describe("plugin api.fetch paths", () => {
  test("stays inside the plugin namespace", () => {
    expect(pluginFetchUrl(BASE, "hello", "/stats")).toBe("/admin/api/plugins/x/hello/stats");
    expect(pluginFetchUrl(BASE, "hello", "stats")).toBe("/admin/api/plugins/x/hello/stats");
    expect(pluginFetchUrl(BASE, "hello", "a/b?x=1&y=../z")).toBe("/admin/api/plugins/x/hello/a/b?x=1&y=../z");
    expect(pluginFetchUrl(BASE, "hello", "")).toBe("/admin/api/plugins/x/hello/");
    expect(pluginFetchUrl(BASE, "hello", "file.v2.json")).toBe("/admin/api/plugins/x/hello/file.v2.json");
  });

  test("encodes the plugin name", () => {
    expect(pluginFetchUrl(BASE, "a/../b", "x")).toBe("/admin/api/plugins/x/a%2F..%2Fb/x");
  });

  test.each([
    "../users",
    "/../../users",
    "a/../../users",
    "..",
    ".",
    "a/./b",
    "%2e%2e/users",
    "%2E%2e/users",
    ".%2e/users",
    "a%2f..%2f..%2fusers",
    "a%5c..",
    "..\\users",
    "\\\\evil.example/x",
    ".\t./users",
    "a\n/b",
    "https://evil.example/x",
    "javascript:alert(1)",
    "//evil.example/x",
    "%zz",
  ])("refuses %p", (path) => {
    expect(() => pluginFetchUrl(BASE, "hello", path)).toThrow(PluginPathError);
  });

  test("drops the fragment", () => {
    expect(pluginRelativePath("a#../../x")).toBe("a");
  });
});
