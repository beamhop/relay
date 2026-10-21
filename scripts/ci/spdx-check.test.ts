// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { SPDX, addHeader, candidateFiles, hasHeader } from './spdx-check.ts';

describe('spdx-check', () => {
  test('finds the header in the first lines, after a shebang too', () => {
    expect(hasHeader(`// ${SPDX}\nexport {};`)).toBe(true);
    expect(hasHeader(`#!/usr/bin/env bun\n// ${SPDX}\n`)).toBe(true);
    expect(hasHeader(`<!-- ${SPDX} -->\n<script></script>`)).toBe(true);
    expect(hasHeader('export {};\n')).toBe(false);
  });

  test('adds the header in the file comment style, keeping a shebang first', () => {
    expect(addHeader('a.ts', 'x\n')).toBe(`// ${SPDX}\nx\n`);
    expect(addHeader('a.svelte', '<script>')).toBe(`<!-- ${SPDX} -->\n<script>`);
    expect(addHeader('cli.ts', '#!/usr/bin/env bun\nx\n')).toBe(
      `#!/usr/bin/env bun\n// ${SPDX}\nx\n`,
    );
  });

  test('skips vendored, generated and upstream Flotilla files', () => {
    const files = candidateFiles();
    expect(files).toContain('scripts/ci/spdx-check.ts');
    expect(files.some((f) => f.startsWith('packages/relay/src/vendor/'))).toBe(false);
    expect(files.some((f) => f.startsWith('packages/pwa/src/lib/paraglide/'))).toBe(false);
    const team = files.filter((f) => f.startsWith('packages/team-client/'));
    expect(team.every((f) => /^packages\/team-client\/(src|scripts)\/beamhop\//.test(f))).toBe(
      true,
    );
  });
});
