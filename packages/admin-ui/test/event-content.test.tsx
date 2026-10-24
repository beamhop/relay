import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NostrEvent } from "@beamhop/sdk/admin-contract";

// lib/api reads Vite's import.meta.env.BASE_URL at import time (process.env under bun)
const setBase = process.env.BASE_URL === undefined;
let EventContent: typeof import("../src/components/event-card").EventContent;
beforeAll(async () => {
  if (setBase) process.env.BASE_URL = "/admin/";
  ({ EventContent } = await import("../src/components/event-card"));
});
afterAll(() => {
  if (setBase) delete process.env.BASE_URL;
});

const ev = (kind: number, content: string, tags: string[][] = []): NostrEvent => ({ id: "e".repeat(64), pubkey: "a".repeat(64), sig: "f".repeat(128), created_at: 1_700_000_000, kind, content, tags });
const render = (e: NostrEvent, sensitive = false) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <EventContent event={e} sensitive={sensitive} />
    </QueryClientProvider>,
  );

describe("EventContent with crafted events", () => {
  test.each([
    ["kind 0, object name", ev(0, '{"name":{"x":1}}')],
    ["kind 0, number display_name", ev(0, '{"display_name":1}')],
    ["kind 0, null", ev(0, "null")],
    ["kind 6, number inner content", ev(6, '{"content":1}')],
    ["kind 16, array inner content", ev(16, '{"content":["a"]}')],
    ["kind 1984, value-less e tag", ev(1984, "spam", [["e"]])],
  ])("%s renders", (_l, e) => {
    expect(() => render(e)).not.toThrow();
  });
});

describe("EventContent media", () => {
  const note = ev(1, "look https://tracker.example/p.png and https://tracker.example/v.mp4");
  test("remote note media waits for a click", () => {
    const html = render(note);
    expect(html).not.toContain('src="https://tracker.example');
    expect(html).toContain("Load image");
    expect(html).toContain("Load video");
  });
  test("remote profile pictures in kind 0 don't load", () => {
    expect(render(ev(0, '{"name":"x","picture":"https://tracker.example/a.png"}'))).not.toContain('src="https://tracker.example');
  });
  test("long-form image tag waits for a click", () => {
    expect(render(ev(30023, "body", [["image", "https://tracker.example/i.png"]]))).not.toContain('src="https://tracker.example');
  });
  test("reported content never auto-loads media", () => {
    const html = render(note, true);
    expect(html).not.toContain('src="https://tracker.example');
    expect(html).toContain("Show reported image");
  });
});
