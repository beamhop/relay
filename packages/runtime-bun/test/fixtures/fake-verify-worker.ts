// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Test double for verify-worker.ts: a signature is "valid" when it equals "ok".
 * Ids starting with `throw` crash the worker, `exit` make it exit, `hang` never
 * answer, `slow` answer after 50 ms.
 */
interface Scope {
  postMessage(m: unknown): void;
  onmessage: ((e: MessageEvent<{ seq: number; data: string[] }>) => void) | null;
}
const scope = globalThis as unknown as Scope;

scope.onmessage = (e) => {
  const { seq, data } = e.data;
  const ids = data.filter((_, i) => i % 3 === 0);
  if (ids.some((id) => id.startsWith('throw'))) throw new Error('boom');
  if (ids.some((id) => id.startsWith('exit'))) process.exit(1);
  if (ids.some((id) => id.startsWith('hang'))) return;
  const ok = new Uint8Array(ids.length);
  for (let i = 0; i < ids.length; i++) ok[i] = data[i * 3 + 2] === 'ok' ? 1 : 0;
  const reply = () => scope.postMessage({ seq, ok, batch: ids.length });
  if (ids.some((id) => id.startsWith('slow'))) setTimeout(reply, 50);
  else reply();
};
