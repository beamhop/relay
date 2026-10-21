// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules.ai` — assistant limits and background-labeling settings.
 * The connection itself (endpoint, model, key) lives in the core `config.ai`.
 */
import { technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'ai';

/** DocStore collections owned by this module. */
export const COL = {
  labels: 'ai.labels',
  plugins: 'ai.plugins',
} as const;

export const DEFAULT_OLLAMA_URL = 'http://localhost:11434/v1';
export const DEFAULT_MODEL = 'llama3.1';

export const AiModuleConfigSchema = z
  .object({
    maxRounds: technical(
      z.number().int().min(1).max(20).default(6),
      'Max LLM round trips (tool call → result → next call) per question.',
    ).describe('How many steps the assistant may take to answer one question'),
    maxToolCalls: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(12)
      .describe('How many lookups the assistant may do for one question'),
    maxTokensPerRequest: technical(
      z.number().int().min(500).default(24_000),
      'Budget across all rounds: provider-reported usage when available, else ~4 chars per token.',
    ).describe('Upper limit on how much text one question may use (keeps costs predictable)'),
    maxOutputTokens: z
      .number()
      .int()
      .min(64)
      .default(1_200)
      .describe('Longest answer the assistant may write'),
    timeoutSeconds: z
      .number()
      .int()
      .min(5)
      .max(600)
      .default(90)
      .describe('Give up on a question after this long'),
    maxToolResultChars: z.number().int().min(500).default(8_000),
    maxProposals: z
      .number()
      .int()
      .min(0)
      .max(20)
      .default(5)
      .describe('How many suggested changes one answer may contain'),
    labeling: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Suggest a label (spam / abusive / fine) for new items waiting for review'),
        intervalSeconds: z.number().int().min(10).default(60),
        perRun: technical(
          z.number().int().min(1).max(100).default(10),
          'Max queue items labeled per scheduler tick (rate limit).',
        ),
        perHour: z
          .number()
          .int()
          .min(1)
          .default(200)
          .describe('Most items labeled per hour (rate limit)'),
        maxAttempts: z.number().int().min(1).max(5).default(2),
      })
      .prefault({}),
  })
  .prefault({});

export type AiModuleConfig = z.infer<typeof AiModuleConfigSchema>;
