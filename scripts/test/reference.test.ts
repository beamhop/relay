// SPDX-License-Identifier: AGPL-3.0-or-later
/** docs/reference/generate.ts boots every module in-process and renders both pages. */
import { describe, expect, test } from 'bun:test';
import { generate } from '../../docs/reference/generate.ts';

describe('reference generator', () => {
  test('renders settings (with technical notes) and actions', async () => {
    const pages = await generate();
    const config = pages['config.md']!;
    expect(config).toContain('## Core settings');
    expect(config).toContain('`node.tls.mode`');
    expect(config).toContain('BEAMHOP_NODE__TLS__MODE');
    expect(config).toContain('*Technical:* NIP-42');
    const actions = pages['actions.md']!;
    expect(actions).toContain('# Actions reference');
    expect(actions).toMatch(/\*\*CLI:\*\* `beamhop [a-z-]+ [a-z-]+`/);
  }, 30_000);
});
