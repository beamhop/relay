// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lazy registry of module screens. Each `src/lib/modules/<chunk>.svelte`
 * becomes its own code-split chunk; it is fetched only when `/ui` lists a
 * route with that chunk name (i.e. the module is enabled) and it is opened.
 */
import type { Component } from 'svelte';

const chunks = import.meta.glob<{ default: Component }>('./modules/*.svelte');

export function moduleChunk(name: string): (() => Promise<{ default: Component }>) | null {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  return chunks[`./modules/${name}.svelte`] ?? null;
}

export function availableChunks(): string[] {
  return Object.keys(chunks).map((k) => k.replace('./modules/', '').replace('.svelte', ''));
}
