import { describe, expect, test } from "bun:test";
import { isChunkLoadError } from "../src/lib/app-update";

describe("isChunkLoadError", () => {
  test.each([
    "Failed to fetch dynamically imported module: https://relay.example/admin/assets/users-AbC123.js", // Chromium
    "error loading dynamically imported module: https://relay.example/admin/assets/users-AbC123.js", // Firefox
    "Importing a module script failed.", // Safari
    "Unable to preload CSS for /admin/assets/world-map-x.css", // Vite's preload helper
  ])("recognises %p", (msg) => {
    expect(isChunkLoadError(new TypeError(msg))).toBe(true);
  });

  test("ignores other errors", () => {
    expect(isChunkLoadError(new TypeError("Cannot read properties of null (reading 'nips')"))).toBe(false);
    expect(isChunkLoadError("Failed to fetch dynamically imported module")).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});
