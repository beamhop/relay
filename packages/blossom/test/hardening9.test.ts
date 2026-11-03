import { afterEach, describe, expect, test } from "bun:test";
import { isSvgText, typeOfUnrecognized } from "../src/mime";
import { PNG_1x1, authHeader, createHarness, newUser, type Harness, xOf } from "./fakes";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const alice = newUser();
const enc = (s: string) => new TextEncoder().encode(s);
const upload = (body: Uint8Array, sk = alice.sk) =>
  h!.request("/upload", { method: "PUT", body: body as BodyInit, headers: { authorization: authHeader(sk, "upload", { x: [xOf(body)] }) } });

describe("SVG sniffing is linear (1)", () => {
  test("many comments before a non-SVG tag fail fast (no catastrophic backtracking)", () => {
    for (const n of [40, 1000, 5000]) {
      for (const prefix of ["", '<?xml version="1.0"?>']) {
        const body = enc(`${prefix}${"<!---->".repeat(n)}x<i>`);
        const t = performance.now();
        expect(isSvgText(body)).toBe(false);
        expect(typeOfUnrecognized(body, "text/plain")).toBe("text/plain");
        expect(performance.now() - t).toBeLessThan(50);
      }
    }
  });

  test("still recognises SVG behind a BOM, prolog, comments and a doctype, in any case", () => {
    const yes = [
      "<svg/>",
      "﻿  <svg xmlns='x'>",
      '<?xml version="1.0"?>\n<svg>',
      "<!-- a --> <!-- b -->\n<SVG\t>",
      '<?xml version="1.0"?><!-- c --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><!-- d --><svg>',
      "<!-- <svg> inside a comment --><svg>",
      `${"<!---->".repeat(1000)}<svg>`,
    ];
    for (const s of yes) expect([s.slice(0, 40), isSvgText(enc(s))]).toEqual([s.slice(0, 40), true]);
    const no = ["<svgx>", "<!-- unterminated <svg>", "<?xml version='1.0'><svg>", "<!DOCTYPE a><!DOCTYPE b><svg>", "x<svg>", "<html><svg>", "<!-- <svg> -->"];
    for (const s of no) expect([s, isSvgText(enc(s))]).toEqual([s, false]);
  });

  test("an upload of the attack body is answered without stalling the event loop", async () => {
    h = await createHarness({ useSharp: false });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    const t = performance.now();
    for (let i = 0; i < 4; i++) await upload(enc(`${"<!---->".repeat(40)}x<i${i}>`));
    clearInterval(timer);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("an admin delete keeps the moderation decision (2)", () => {
  test("a blocked blob deleted by an admin can't be re-uploaded", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(201);
    await h.svc.setStatus(x, "blocked", "mod");
    await h.svc.delete(x, "mod");
    const again = await upload(PNG_1x1);
    expect(again.status).toBe(403);
  });

  test("a pending blob deleted by an admin comes back pending, not approved", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(201);
    await h.svc.setStatus(x, "pending", "mod");
    await h.svc.delete(x, "mod");
    expect((await upload(PNG_1x1)).status).toBe(201);
    expect((await h.request(`/${x}`)).status).toBe(404);
  });

  test("an approved blob deleted by an admin can be uploaded again", async () => {
    h = await createHarness({ useSharp: false });
    const x = xOf(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(201);
    await h.svc.delete(x, "mod");
    expect((await upload(PNG_1x1)).status).toBe(201);
    expect((await h.request(`/${x}`)).status).toBe(200);
  });
});
