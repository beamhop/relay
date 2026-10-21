// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Tool routing: every action the admin may run is a tool, but sending all of them
 * (60–130 tools, 7k–18k tokens) overflows small local models — Ollama silently cuts
 * the prompt, and the model never sees the tool it needs. So each question gets:
 * - the built-in tools (always),
 * - the action tools whose words best match the question and screen (`maxTools`),
 * - `find_tools`, which searches ALL permitted tools and makes the matches callable
 *   in the next round — nothing the admin can do is out of reach.
 * Plain word matching with stems and a few synonyms (teams → groups): no model calls.
 */
import { z } from 'zod';
import { type AssistantTool, toolParameters } from './tools.ts';

export const FIND_TOOLS = 'find_tools';

const STOP = new Set(
  'a an and any are about all as at be by can could do does did for from get give got have has how i in is it its list me many much my now of on or our please show some tell that the there this to us we what when where which who why will with you your'.split(
    ' ',
  ),
);

/** Admin words → words the actions use. */
const SYNONYMS: Record<string, string[]> = {
  team: ['group', 'admin'],
  channel: ['group'],
  chat: ['group'],
  room: ['group'],
  community: ['group'],
  user: ['people', 'member', 'account'],
  member: ['people', 'user', 'group'],
  people: ['user', 'member'],
  person: ['people', 'user'],
  staff: ['admin', 'team'],
  moderator: ['admin', 'role'],
  ban: ['block', 'moderation'],
  block: ['ban', 'moderation'],
  spam: ['moderation', 'report', 'queue'],
  report: ['moderation', 'queue'],
  abuse: ['moderation', 'report'],
  file: ['blob', 'media'],
  image: ['media', 'blob'],
  photo: ['media', 'blob'],
  picture: ['media', 'blob'],
  video: ['media', 'blob'],
  upload: ['media', 'blob'],
  space: ['storage', 'disk'],
  disk: ['storage'],
  error: ['log'],
  problem: ['error', 'health'],
  log: ['error', 'audit'],
  history: ['audit', 'revision'],
  change: ['audit', 'revision'],
  invite: ['access', 'invitation'],
  key: ['token'],
  password: ['token', 'security'],
  traffic: ['metric', 'insight'],
  stat: ['metric', 'insight'],
  post: ['event', 'note'],
  message: ['event', 'note'],
  note: ['event'],
  event: ['note'],
  update: ['system', 'version'],
  version: ['system', 'update'],
  domain: ['host', 'tls'],
  notification: ['alert'],
  alert: ['notification'],
};

function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Lowercase word stems, without filler words. */
export function terms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => (w.length > 1 || /\d/.test(w)) && !STOP.has(w))
    .map(stem);
}

interface Index {
  strong: Set<string>;
  weak: Set<string>;
}

const indexCache = new WeakMap<AssistantTool, Index>();

function indexOf(t: AssistantTool): Index {
  const hit = indexCache.get(t);
  if (hit) return hit;
  const desc = t.spec.description ?? '';
  // Name and title (the description's first sentence) are strong; the rest is weak.
  const title = desc.replace(/^(Look up|Suggest): /, '').split('. ')[0] ?? '';
  const idx = {
    strong: new Set([...terms(t.actionId ?? t.spec.name), ...terms(title)]),
    weak: new Set(terms(desc)),
  };
  indexCache.set(t, idx);
  return idx;
}

/** Relevance of `t` to the query words (0 = unrelated). Exact words count double synonyms. */
export function score(t: AssistantTool, query: string): number {
  const idx = indexOf(t);
  let s = 0;
  const seen = new Set<string>();
  const add = (w: string, weight: number) => {
    if (seen.has(w)) return;
    seen.add(w);
    if (idx.strong.has(w)) s += 3 * weight;
    else if (idx.weak.has(w)) s += weight;
  };
  const words = terms(query);
  for (const w of words) add(w, 2);
  for (const w of words) for (const syn of SYNONYMS[w] ?? []) add(syn, 1);
  return s;
}

/** The `max` most relevant tools for `query`, best first (ties keep registry order). */
export function rankTools(tools: AssistantTool[], query: string, max: number): AssistantTool[] {
  return tools
    .map((t, i) => ({ t, i, s: score(t, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.t);
}

const FindInput = z.object({
  query: z
    .string()
    .min(1)
    .max(200)
    .describe('A few words about what you need, e.g. "groups", "banned people", "disk space"'),
});

/** Search every permitted tool; matches become callable from the next round on. */
export function findToolsTool(
  all: () => AssistantTool[],
  unlock: (names: string[]) => void,
): AssistantTool {
  return {
    kind: 'read',
    spec: {
      name: FIND_TOOLS,
      description:
        'Search all the tools you may use (everything this admin is allowed to look up or suggest). Use it when none of your tools fits the question. The tools it finds can be called right after.',
      parameters: toolParameters(FindInput).schema,
    },
    async run(args) {
      const parsed = FindInput.safeParse(args ?? {});
      if (!parsed.success) return { ok: false, error: 'Say what you are looking for in "query".' };
      const found = rankTools(all(), parsed.data.query, 8);
      unlock(found.map((t) => t.spec.name));
      return {
        ok: true,
        summary: found.length ? `Found ${found.length} matching tools` : 'No matching tools',
        result: found.length
          ? {
              tools: found.map((t) => ({
                name: t.spec.name,
                what: (t.spec.description ?? '').slice(0, 200),
              })),
              next: 'Call one of these tools now.',
            }
          : { tools: [], next: 'Nothing matches. Tell the admin you cannot look that up.' },
      };
    },
  };
}
