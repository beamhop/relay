// SPDX-License-Identifier: AGPL-3.0-or-later
/** Worker thread for `load.ts`: signs a slice of event templates (signing is CPU-bound). */
import { type NostrEvent, finalizeEvent } from '../../packages/core/src/index.ts';

declare const self: Worker;

export interface SignJob {
  templates: Array<{
    key: number;
    kind: number;
    created_at: number;
    content: string;
    tags: string[][];
  }>;
  keys: string[];
}

self.onmessage = (e: MessageEvent<SignJob>) => {
  const { templates, keys } = e.data;
  const out: NostrEvent[] = templates.map((t) =>
    finalizeEvent(
      { kind: t.kind, created_at: t.created_at, content: t.content, tags: t.tags },
      keys[t.key]!,
    ),
  );
  self.postMessage(out);
};
