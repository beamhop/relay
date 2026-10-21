// SPDX-License-Identifier: AGPL-3.0-or-later
/** Generated action forms never ask for approval ids; the approvals flow fills them. */
import { describe, expect, it } from 'vitest';
import type { JsonSchema } from '../src/lib/api/types.ts';
import { visibleFields, withHiddenInputs } from '../src/lib/components/action-fields.ts';
import { fieldsFromSchema } from '../src/lib/forms/json-schema.ts';

describe('action form fields', () => {
  const schema = {
    type: 'object',
    properties: {
      pubkey: { type: 'string' },
      approvalId: { type: 'string' },
      _approvalId: { type: 'string' },
      meta: { type: 'object', properties: { approvalId: { type: 'string' } } },
    },
  } as unknown as JsonSchema;

  it('hides approvalId and _approvalId at the top level only', () => {
    const shown = visibleFields(fieldsFromSchema(schema));
    const paths = shown.flatMap((f) =>
      f.children ? f.children.map((c) => c.path.join('.')) : [f.path.join('.')],
    );
    expect(paths).toContain('pubkey');
    expect(paths).not.toContain('approvalId');
    expect(paths).not.toContain('_approvalId');
    expect(paths).toContain('meta.approvalId');
  });

  it('keeps the approval id the flow already had', () => {
    expect(withHiddenInputs({ pubkey: 'x' }, { pubkey: 'y', _approvalId: 'ap1' })).toEqual({
      pubkey: 'x',
      _approvalId: 'ap1',
    });
    expect(withHiddenInputs({ pubkey: 'x' }, undefined)).toEqual({ pubkey: 'x' });
    expect(withHiddenInputs({ approvalId: 'new' }, { approvalId: 'old' })).toEqual({
      approvalId: 'new',
    });
  });
});
