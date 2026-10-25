/** longest list stored in one audit entry's details */
export const AUDIT_LIST_MAX = 1000;

/**
 * Lists for an audit entry's details (bulk targets, failures, ids): each is kept up to AUDIT_LIST_MAX entries, with
 * `<name>Count` holding its full length; `truncated: true` marks an entry where any list was cut. Keeps rows bounded
 * (a 10,000-id delete would otherwise store ~1 MB) while the counts stay exact.
 */
export function auditLists(lists: Record<string, readonly unknown[]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let truncated = false;
  for (const [name, list] of Object.entries(lists)) {
    out[name] = list.length > AUDIT_LIST_MAX ? list.slice(0, AUDIT_LIST_MAX) : list;
    out[`${name}Count`] = list.length;
    if (list.length > AUDIT_LIST_MAX) truncated = true;
  }
  if (truncated) out.truncated = true;
  return out;
}

/**
 * Runs a destructive action and audits it however it ends: a failure halfway (a store error after some deletes) is
 * recorded too, with the partial counts `details()` reads at that point and the `error`. Rethrows. `changedNothing`: when
 * it says so after a failure (a refused rank check), nothing is recorded.
 */
export async function audited<T>(
  record: (details: Record<string, unknown>) => Promise<void>,
  details: () => Record<string, unknown>,
  run: () => Promise<T>,
  changedNothing?: () => boolean,
): Promise<T> {
  let error: string | undefined;
  try {
    return await run();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    if (error === undefined || !changedNothing?.()) await record({ ...details(), ...(error !== undefined ? { error } : {}) });
  }
}
