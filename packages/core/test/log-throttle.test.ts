import { expect, test } from "bun:test";
import { LogThrottle } from "../src/util/log-throttle";

test("LogThrottle: the first of a burst is logged, repeats are counted and reported with the next one", () => {
  let now = 0;
  const t = new LogThrottle(10_000, 3, () => now);
  expect(t.take("disk full")).toEqual({ log: true, suppressed: 0 });
  for (let i = 0; i < 500; i++) expect(t.take("disk full").log).toBe(false);
  expect(t.take("other").log).toBe(true);
  now = 10_000;
  expect(t.take("disk full")).toEqual({ log: true, suppressed: 500 });
  expect(t.take("disk full").log).toBe(false);
  // bounded: distinct messages beyond maxKeys reset the table instead of growing it
  for (const k of ["a", "b", "c", "d"]) expect(t.take(k).log).toBe(true);
  expect(t.take("disk full")).toEqual({ log: true, suppressed: 0 });
});
