// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type BeamhopConfig, ConfigSchema } from '@beamhop/core';
import { MemoryDocStore } from '@beamhop/testkit';
import YAML from 'yaml';
import { describeChanges } from '../src/config/describe.ts';
import { applyPatch, diffPatch, mergePatch } from '../src/config/patch.ts';
import { type AdminConfigService, resolveBootConfig } from '../src/index.ts';
import { NODE, RELAY, addMember, bootClaimed, call } from './helpers.ts';

describe('JSON patch helpers', () => {
  test('apply / diff roundtrip and merge patch', () => {
    const a = { x: 1, arr: [1, 2], nested: { y: 'a', gone: true }, list: [{ id: 'a', v: 1 }] };
    const b = { x: 2, arr: [1, 2, 3], nested: { y: 'b' }, list: [{ id: 'a', v: 2 }], added: null };
    const patch = diffPatch(a, b);
    expect(applyPatch<unknown>(a, patch)).toEqual(b);
    expect(patch).toContainEqual({ op: 'replace', path: '/list/0/v', value: 2 });
    expect(
      applyPatch<unknown>({ a: [1, 2] }, [
        { op: 'add', path: '/a/-', value: 3 },
        { op: 'move', from: '/a/0', path: '/b' },
      ]),
    ).toEqual({ a: [2, 3], b: 1 });
    expect(() => applyPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }])).toThrow();
    expect(() => applyPatch({ a: 1 }, [{ op: 'remove', path: '/nope' }])).toThrow();
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 } }, { b: { c: null, e: 4 } })).toEqual({
      a: 1,
      b: { d: 3, e: 4 },
    });
  });

  test('diff lines come from describe() texts with a technical lens', () => {
    const prev = ConfigSchema.parse({ relays: [{ id: 'main', hosts: ['a.example'] }] });
    const next = ConfigSchema.parse({
      relays: [
        {
          id: 'main',
          hosts: ['a.example'],
          access: { mode: 'allowlist', authRequired: { write: true } },
          goals: { openness: 30 },
          limits: { minPowDifficulty: 20 },
          info: { name: 'Cozy' },
        },
        { id: 'team', hosts: ['t.example'] },
      ],
      storage: { url: 'file.db' },
      ai: { apiKey: 'sk-secret' },
    });
    const lines = describeChanges(prev, next, ConfigSchema);
    const texts = lines.map((l) => l.text);
    expect(texts).toContain('Relay “main” · Who can post: “open” → “allowlist”');
    expect(texts).toContain('Relay “main” · People must sign in to post: off → on');
    expect(texts).toContain('Relay “main” · How open the relay is: 70 → 30');
    expect(texts).toContain('Added relay “team”');
    expect(texts).toContain('Database file path or connection URL: set to “file.db”');
    const mode = lines.find((l) => l.text.includes('Who can post'))!;
    expect(mode.technical).toContain('relays[main].access.mode: "open" → "allowlist"');
    expect(mode.technical).toContain('wot: follow graph'); // technical() note survives .describe()
    const pow = lines.find((l) => l.technical?.includes('minPowDifficulty'))!;
    expect(pow.technical).toContain('NIP-13');
    const secret = lines.find((l) => l.technical?.includes('apiKey'))!;
    expect(secret.text).not.toContain('sk-secret');
    expect(secret.technical).not.toContain('sk-secret');
    expect(lines.at(-1)).toMatchObject({
      kind: 'warning',
      text: 'Some of these changes take effect after a restart',
    });
  });
});

describe('config service over HTTP', () => {
  test('propose → commit → undo, with plain diff and audit', async () => {
    const env = await bootClaimed();
    const t = env.ownerToken;
    const cur = await call(env.kernel, 'GET', `${NODE}/config`, { token: t });
    expect(cur.json.revision).toBe(1);

    const bad = await call(env.kernel, 'POST', `${NODE}/config/propose`, {
      token: t,
      body: { patch: [{ op: 'replace', path: '/relays/0/goals/openness', value: 500 }] },
    });
    expect(bad.status).toBe(422);
    expect(bad.json.error.issues[0].path).toBe('relays.0.goals.openness');

    const p = await call(env.kernel, 'POST', `${NODE}/config/propose`, {
      token: t,
      body: { patch: [{ op: 'replace', path: '/relays/0/access/mode', value: 'allowlist' }] },
    });
    expect(p.status).toBe(200);
    expect(p.json.changed).toBe(true);
    expect(p.json.summary).toBe('Relay “main” · Who can post: “open” → “allowlist”');
    expect(env.kernel.relay('main')?.access.mode).toBe('open'); // not applied yet

    const changes: number[] = [];
    env.kernel.bus.on('config.changed', (e) => changes.push(e.revision));
    const c = await call(env.kernel, 'POST', `${NODE}/config/commit`, {
      token: t,
      body: { proposalId: p.json.id },
    });
    expect(c.status).toBe(200);
    expect(c.json.revision).toMatchObject({
      revision: 2,
      author: env.owner.pk,
      authorName: 'Ayşe',
      source: 'ui',
      changes: 1,
    });
    expect(env.kernel.relay('main')?.access.mode).toBe('allowlist');
    expect(changes).toEqual([2]);
    // Proposals are single-use.
    expect(
      (
        await call(env.kernel, 'POST', `${NODE}/config/commit`, {
          token: t,
          body: { proposalId: p.json.id },
        })
      ).status,
    ).toBe(404);

    const act = await call(env.kernel, 'GET', `${NODE}/activity`, { token: t });
    expect(act.json.items[0].text).toBe(
      'Ayşe changed settings: relay “main” · Who can post: “open” → “allowlist”',
    );

    // Undo through the generic undo endpoint.
    const u = await call(env.kernel, 'POST', `${NODE}/undo/${c.json.undo.token}`, { token: t });
    expect(u.status).toBe(200);
    expect(env.kernel.relay('main')?.access.mode).toBe('open');
    const hist = await call(env.kernel, 'GET', `${NODE}/config/revisions`, { token: t });
    expect(
      hist.json.items.map((r: { revision: number; source: string }) => [r.revision, r.source]),
    ).toEqual([
      [3, 'undo'],
      [2, 'ui'],
      [1, 'initial'],
    ]);
  });

  test('undo window, conflicts and time-machine restore', async () => {
    const env = await bootClaimed();
    const t = env.ownerToken;
    const change = async (merge: unknown) => {
      const p = await call(env.kernel, 'POST', `${NODE}/config/propose`, {
        token: t,
        body: { merge },
      });
      return call(env.kernel, 'POST', `${NODE}/config/commit`, {
        token: t,
        body: { proposalId: p.json.id },
      });
    };
    const r2 = await change({ privacy: { ipLogging: 'off' } });
    expect(r2.json.revision.revision).toBe(2);
    // Stale proposal → conflict
    const stale = await call(env.kernel, 'POST', `${NODE}/config/propose`, {
      token: t,
      body: { merge: { ai: { enabled: true } } },
    });
    await change({ alerts: { digest: 'weekly' } });
    const conflict = await call(env.kernel, 'POST', `${NODE}/config/commit`, {
      token: t,
      body: { proposalId: stale.json.id },
    });
    expect(conflict.status).toBe(409);
    // Undo of revision 2 is no longer possible (not the latest).
    expect(
      (await call(env.kernel, 'POST', `${NODE}/config/undo`, { token: t, body: { revision: 2 } }))
        .status,
    ).toBe(409);
    // Window expiry
    env.ports.clock.advance(301);
    const late = await call(env.kernel, 'POST', `${NODE}/config/undo`, {
      token: t,
      body: { revision: 3 },
    });
    expect(late.status).toBe(410);

    // Restore revision 1 (time machine): preview diff then restore, undoable.
    const d = await call(env.kernel, 'GET', `${NODE}/config/revisions/1/diff`, { token: t });
    expect(d.json.diff.map((l: { text: string }) => l.text)).toContain(
      'Ip logging: “off” → “hashed”',
    );
    const rs = await call(env.kernel, 'POST', `${NODE}/config/revisions/1/restore`, { token: t });
    expect(rs.status).toBe(200);
    expect(rs.json.revision.summary).toBe('Restored settings from revision 1');
    expect(env.kernel.config().privacy.ipLogging).toBe('hashed');
    const full = await call(env.kernel, 'GET', `${NODE}/config/revisions/4`, { token: t });
    expect(full.json.diff.length).toBeGreaterThan(0);
    await call(env.kernel, 'POST', `${NODE}/undo/${rs.json.undo.token}`, { token: t });
    expect(env.kernel.config().privacy.ipLogging).toBe('off');
  });

  test('relay-scoped config: relay admins change only their relay', async () => {
    const env = await bootClaimed();
    const teamAdmin = await addMember(env, 'admin', 'team');
    const ok = await call(env.kernel, 'POST', `${RELAY('team')}/config/propose`, {
      token: teamAdmin.token,
      body: { merge: { info: { name: 'Team room' } } },
    });
    expect(ok.status).toBe(200);
    expect(ok.json.diff[0].text).toBe('Relay “team” · Name: “Beamhop Relay” → “Team room”');
    const commit = await call(env.kernel, 'POST', `${RELAY('team')}/config/commit`, {
      token: teamAdmin.token,
      body: { proposalId: ok.json.id },
    });
    expect(commit.status).toBe(200);
    expect(env.kernel.relay('team')?.info.name).toBe('Team room');
    // Cannot rename the relay id, cannot touch node config, cannot touch other relays.
    const rename = await call(env.kernel, 'POST', `${RELAY('team')}/config/propose`, {
      token: teamAdmin.token,
      body: { merge: { id: 'x' } },
    });
    expect(rename.status).toBe(403);
    expect(
      (
        await call(env.kernel, 'POST', `${NODE}/config/propose`, {
          token: teamAdmin.token,
          body: { merge: {} },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(env.kernel, 'POST', `${RELAY('main')}/config/propose`, {
          token: teamAdmin.token,
          body: { merge: {} },
        })
      ).status,
    ).toBe(403);
    // Relay view
    const view = await call(env.kernel, 'GET', `${RELAY('team')}/config`, {
      token: teamAdmin.token,
    });
    expect(view.json.relay.info.name).toBe('Team room');
  });

  test('secrets are masked for readers without config.write', async () => {
    const env = await bootClaimed();
    const p = await call(env.kernel, 'POST', `${NODE}/config/propose`, {
      token: env.ownerToken,
      body: { merge: { ai: { apiKey: 'sk-123' } } },
    });
    expect(JSON.stringify(p.json)).not.toContain('sk-123');
    await call(env.kernel, 'POST', `${NODE}/config/commit`, {
      token: env.ownerToken,
      body: { proposalId: p.json.id },
    });
    const viewer = await addMember(env, 'viewer');
    const v = await call(env.kernel, 'GET', `${NODE}/config`, { token: viewer.token });
    expect(v.json.config.ai.apiKey).toBe('•••');
    const o = await call(env.kernel, 'GET', `${NODE}/config`, { token: env.ownerToken });
    expect(o.json.config.ai.apiKey).toBe('sk-123');
    const schema = await call(env.kernel, 'GET', `${NODE}/config/schema`, { token: viewer.token });
    expect(schema.json.properties.relays).toBeDefined();
  });

  test('YAML export/import roundtrip', async () => {
    const env = await bootClaimed();
    const t = env.ownerToken;
    const y = await call(env.kernel, 'GET', `${NODE}/config/export.yaml`, { token: t });
    expect(y.status).toBe(200);
    expect(y.headers.get('content-type')).toContain('yaml');
    const doc = YAML.parse(y.text) as BeamhopConfig;
    expect(doc.node.id).toBe('n1');
    doc.relays[0]!.info.description = 'Imported from git';
    const imp = await call(env.kernel, 'POST', `${NODE}/config/import`, {
      token: t,
      body: { yaml: YAML.stringify(doc) },
    });
    expect(imp.status).toBe(200);
    expect(imp.json.diff.map((l: { text: string }) => l.text)).toEqual([
      'Relay “main” · Description: “” → “Imported from git”',
    ]);
    const c = await call(env.kernel, 'POST', `${NODE}/config/commit`, {
      token: t,
      body: { proposalId: imp.json.id },
    });
    expect(c.json.revision.source).toBe('import');
    expect(env.kernel.relay('main')?.info.description).toBe('Imported from git');
    const broken = await call(env.kernel, 'POST', `${NODE}/config/import`, {
      token: t,
      body: { yaml: 'relays: [: :' },
    });
    expect(broken.status).toBe(400);
  });
});

describe('boot helpers and runtime services', () => {
  test('file wins on boot, write-back, known-good / safe mode, apply()', async () => {
    const env = await bootClaimed();
    const svc = env.kernel.use<AdminConfigService>('admin.config')!;
    const writes: string[] = [];
    svc.setFileWriter(async (y) => void writes.push(y));

    const cur = (await svc.current()).config;
    const fileCfg = { ...cur, privacy: { ipLogging: 'truncated' as const } };
    const sync = await svc.syncFromFile(YAML.stringify(fileCfg));
    expect(sync).toEqual({ changed: true, revision: 2 });
    expect(env.kernel.config().privacy.ipLogging).toBe('truncated');
    expect((await svc.get(2))?.authorName).toBe('beamhop.yaml');
    expect(writes).toHaveLength(0); // no write-back for file-sourced revisions
    expect(await svc.syncFromFile(YAML.stringify(fileCfg))).toEqual({
      changed: false,
      revision: 2,
    });
    await svc.adoptBootConfig(fileCfg, { source: 'file', path: '/etc/beamhop/beamhop.yaml' });
    expect((await svc.current()).revision).toBe(2);

    expect(await svc.markKnownGood()).toBe(2);
    // apply(): one-step commit used by already-audited actions (e.g. persona changes).
    const applied = await svc.apply(
      { ...fileCfg, alerts: { ...fileCfg.alerts, digest: 'off' } },
      { principalId: env.owner.pk, summary: 'Switched persona', reason: 'test' },
    );
    expect(applied.revisionId).toBe(3);
    expect(applied.undo.token).toBeString();
    expect(env.kernel.config().alerts.digest).toBe('off');
    expect(writes).toHaveLength(1);
    expect(YAML.parse(writes[0]!).alerts.digest).toBe('off');
    expect((await svc.lastKnownGood())?.privacy.ipLogging).toBe('truncated');

    // markKnownGood(config) matches the revision; unknown configs are stored as snapshots.
    expect(await svc.markKnownGood(env.kernel.config())).toBe(3);
    const snap = ConfigSchema.parse({ node: { id: 'snap' } });
    expect(await svc.markKnownGood(snap)).toBe(0);
    expect((await svc.lastKnownGood())?.node.id).toBe('snap');

    // resolveBootConfig against the same DocStore
    const docs = env.ports.docs;
    expect((await resolveBootConfig({ docs, safeMode: true })).config.node.id).toBe('snap');
    expect((await resolveBootConfig({ docs })).source).toBe('revision');
    const fromFile = await resolveBootConfig({ docs, fileYaml: 'node:\n  id: filed\n' });
    expect(fromFile).toMatchObject({ source: 'file' });
    expect(fromFile.config.node.id).toBe('filed');
    expect((await resolveBootConfig({ docs: new MemoryDocStore() })).source).toBe('default');
  });
});
