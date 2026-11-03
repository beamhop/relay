import { describe, expect, test } from "bun:test";
import { authUrlHandler } from "../src/lib/auth-url";

describe("NIP-46 auth_url from the remote signer", () => {
  test("only http(s) URLs reach the page; others are dropped", () => {
    const seen: string[] = [];
    const h = authUrlHandler((u) => seen.push(u));
    for (const u of ["javascript:alert(document.cookie)", "data:text/html,<script>1</script>", "vbscript:x", "not a url", "https://signer.example/auth?x=1"]) h(u);
    expect(seen).toEqual(["https://signer.example/auth?x=1"]);
  });

  test("the fallback window is opened without an opener", () => {
    const calls: unknown[][] = [];
    const g = globalThis as { window?: unknown };
    const prev = g.window;
    g.window = { open: (...a: unknown[]) => calls.push(a) };
    try {
      authUrlHandler()("javascript:alert(1)");
      authUrlHandler()("https://signer.example/a");
    } finally {
      g.window = prev;
    }
    expect(calls).toEqual([["https://signer.example/a", "_blank", "noopener,noreferrer"]]);
  });
});
