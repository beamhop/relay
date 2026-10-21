// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { route } from '../../deploy/get.beamhop.dev/worker.ts';

const GH = 'https://github.com/beamhop/beamhop/releases';

describe('get.beamhop.dev routes', () => {
  test('install script, manifest and release files', () => {
    expect(route('/')).toEqual({
      proxy: 'https://raw.githubusercontent.com/beamhop/beamhop/main/scripts/install.sh',
    });
    expect(route('/releases/latest.json')).toEqual({
      redirect: `${GH}/latest/download/latest.json`,
    });
    expect(route('/releases/latest/beamhop-linux-x64')).toEqual({
      redirect: `${GH}/latest/download/beamhop-linux-x64`,
    });
    expect(route('/releases/v1.2.3-rc.1/SHA256SUMS')).toEqual({
      redirect: `${GH}/download/v1.2.3-rc.1/SHA256SUMS`,
    });
  });

  test('anything else is 404', () => {
    expect(route('/releases/v1/../x')).toEqual({ status: 404 });
    expect(route('/releases/main/beamhop')).toEqual({ status: 404 });
    expect(route('/admin')).toEqual({ status: 404 });
  });
});
