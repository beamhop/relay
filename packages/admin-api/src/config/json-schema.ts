// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * JSON Schema export for settings forms and help. Every node that carries form/help
 * metadata (core `technical()`, `labels()`, `showWhen()`, `example()`, `recommend()`) gets
 * it as extension keywords, so the PWA can show plain labels, conditional fields,
 * placeholders, recommendations and the technical lens next to the plain `description`:
 *
 *   x-technical    string
 *   x-enumLabels   { [value]: label }
 *   x-showWhen     { path, equals: [...] }   (path relative to the containing object)
 *   x-example      value
 *   x-recommended  { value, why }
 *
 * See the header of packages/core/src/config.ts for the exact semantics.
 */
import { FIELD_HELP_KEYWORDS, type FieldHelp, fieldHelp } from '@beamhop/core';
import { z } from 'zod';

export const TECHNICAL_KEYWORD = FIELD_HELP_KEYWORDS.technical;
export { FIELD_HELP_KEYWORDS };

export function toJsonSchemaWithNotes(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override(ctx) {
      const help = fieldHelp(ctx.zodSchema as unknown as z.ZodType);
      const out = ctx.jsonSchema as Record<string, unknown>;
      for (const [key, keyword] of Object.entries(FIELD_HELP_KEYWORDS)) {
        const value = help[key as keyof FieldHelp];
        if (value !== undefined) out[keyword] = value;
      }
    },
  }) as Record<string, unknown>;
}
