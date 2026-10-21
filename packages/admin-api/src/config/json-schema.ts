// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * JSON Schema export for settings forms and help. Every node that carries a
 * `technical()` note (core) gets it as the `x-technical` extension keyword, so the
 * PWA can show the technical lens next to the plain-language `description`.
 */
import { technicalNote } from '@beamhop/core';
import { z } from 'zod';

export const TECHNICAL_KEYWORD = 'x-technical';

export function toJsonSchemaWithNotes(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override(ctx) {
      const note = technicalNote(ctx.zodSchema as unknown as z.ZodType);
      if (note) (ctx.jsonSchema as Record<string, unknown>)[TECHNICAL_KEYWORD] = note;
    },
  }) as Record<string, unknown>;
}
