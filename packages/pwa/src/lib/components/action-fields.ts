// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generated action forms: fields the admin never types. Approval ids are
 * filled by the approvals flow (two-person rule, §12.9), so they are hidden
 * from the form and carried over from the flow's input unchanged.
 */
import type { FieldSpec } from '$lib/forms/json-schema';

export const HIDDEN_INPUTS = ['approvalId', '_approvalId'] as const;

const hidden = (name: string) => (HIDDEN_INPUTS as readonly string[]).includes(name);

/** The fields a generated action form shows (top-level approval ids removed). */
export function visibleFields(fields: FieldSpec[]): FieldSpec[] {
  return fields.filter((f) => !(f.path.length === 1 && hidden(f.name)));
}

/** Form values plus the hidden inputs the flow already had (e.g. an approval id). */
export function withHiddenInputs(
  values: Record<string, unknown>,
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return values;
  const out = { ...values };
  for (const k of HIDDEN_INPUTS) {
    const v = (input as Record<string, unknown>)[k];
    if (v !== undefined && out[k] === undefined) out[k] = v;
  }
  return out;
}
