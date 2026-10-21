// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional: run mikedilger/relay-tester against a relay if the `relay-tester`
 * binary is on PATH; otherwise explain and exit 0 (skip).
 *
 *   bun scripts/relay-tester.ts wss://relay.example [extra relay-tester args…]
 */
const [url, ...rest] = process.argv.slice(2);
if (!url || !/^wss?:\/\//.test(url)) {
  console.error('Usage: bun scripts/relay-tester.ts <ws(s)://relay> [extra args]');
  process.exit(2);
}
const bin = Bun.which('relay-tester');
if (!bin) {
  console.log(
    'SKIP relay-tester is not installed (see https://github.com/mikedilger/relay-tester); nothing to run.',
  );
  process.exit(0);
}
console.log(`Running ${bin} ${url} ${rest.join(' ')}`.trim());
const proc = Bun.spawn([bin, url, ...rest], { stdout: 'inherit', stderr: 'inherit' });
const code = await proc.exited;
process.exit(code);
