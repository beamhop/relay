// SPDX-License-Identifier: AGPL-3.0-or-later
/** Settings deep links (`?field=`) find the field on the simple screen or in Advanced. */
import { describe, expect, it } from 'vitest';
import type { FieldSpec } from '../src/lib/forms/json-schema.ts';
import { locateField } from '../src/lib/settings/focus.ts';

const f = (path: string): FieldSpec => ({
  name: path.split('.').pop() ?? path,
  path: path.split('.'),
  label: path,
  kind: 'text',
  required: false,
  nullable: false,
  secret: false,
  technical: path,
});

describe('settings deep-link focus', () => {
  const simple = [f('info.name'), f('info.description')];
  const advanced = [f('info.contact'), f('limits.maxEventBytes')];

  it('finds fields on the simple screen and in Advanced', () => {
    expect(locateField('info.name', simple, advanced)).toEqual({
      where: 'simple',
      path: 'info.name',
    });
    expect(locateField('info.contact', simple, advanced)).toEqual({
      where: 'advanced',
      path: 'info.contact',
    });
  });

  it('matches by suffix when the screen uses a longer path', () => {
    const relay = [f('relays.main.info.name')];
    expect(locateField('info.name', relay, [])).toEqual({
      where: 'simple',
      path: 'relays.main.info.name',
    });
    expect(locateField('node.limits.maxEventBytes', simple, advanced)).toEqual({
      where: 'advanced',
      path: 'limits.maxEventBytes',
    });
  });

  it('ignores empty or unknown fields', () => {
    expect(locateField(null, simple, advanced)).toBeNull();
    expect(locateField('', simple, advanced)).toBeNull();
    expect(locateField('info.nope', simple, advanced)).toBeNull();
  });
});
