// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop doctor` (§16): checks DNS, TLS, ports, proxy headers + WebSocket
 * upgrade (via the runtime self-check endpoint), clock skew, disk space and
 * data-dir permissions, database and media storage, and the settings file.
 *
 * Every finding has a plain explanation, a technical lens, and — where it is
 * safe — a one-step fix offered with `--fix`. All outside access goes through
 * `DoctorProbes`, so checks are testable without a network. No third-party
 * services are contacted (privacy): this host's public address comes from its
 * network interfaces or $BEAMHOP_PUBLIC_IP.
 *
 * Exit codes: 0 all good · 4 warnings only · 1 something is broken.
 * The pure `runDoctor()` is exported so an action/API can reuse it later.
 */
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BeamhopConfig } from '@beamhop/core';
import {
  SELF_CHECK_PATH,
  acmeDomains,
  dataLayout,
  ensureDataDir,
  localPublicIps,
  parseListen,
  withDataDirDefaults,
} from '@beamhop/runtime-bun';
import { type FlagSpec, type FlagValues, bool, parseFlags, str } from '../args.ts';
import { type CliContext, localOptions } from '../context.ts';
import { bytes, json } from '../format.ts';
import { EXIT, line, paint } from '../io.ts';
import { cliLogger, resolveLocalConfig } from '../local.ts';
import { sqlitePathOf } from '../snapshot.ts';
import { renderInitYaml } from './init.ts';

export type FindingStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface Fix {
  /** Plain description of what the fix does. */
  description: string;
  apply(): Promise<string>;
}

export interface Finding {
  id: string;
  status: FindingStatus;
  title: string;
  message: string;
  technical?: string;
  fix?: Fix;
}

export interface CertInfo {
  validFrom: number;
  validTo: number;
  issuer?: string;
  names: string[];
  /** Chain trusted by this system. */
  trusted: boolean;
  error?: string;
}

export interface SelfCheckResult {
  ok: boolean;
  tls?: string;
  trustProxy?: boolean;
  seen?: { host: string; proto: string; forwardedFor: boolean; forwardedProto?: string };
  problems: Array<{ message: string; technical: string }>;
}

export interface DoctorProbes {
  now(): number;
  resolveDns(host: string): Promise<string[]>;
  /** This host's public IPs (interfaces / $BEAMHOP_PUBLIC_IP). */
  publicIps(): Promise<string[]>;
  certificate(host: string, port: number): Promise<CertInfo | null>;
  portOpen(host: string, port: number): Promise<boolean>;
  /** GET the self-check JSON at `baseUrl` (null if unreachable). */
  selfCheckHttp(baseUrl: string): Promise<{ body: SelfCheckResult; date?: number } | null>;
  /** Open a WebSocket to the self-check path; true when it answers. */
  selfCheckWs(baseUrl: string): Promise<boolean>;
  diskFree(path: string): Promise<{ free: number; total: number } | null>;
  openDatabase(
    config: BeamhopConfig,
  ): Promise<{ ok: true; detail: string } | { ok: false; error: string }>;
  blobRoundTrip(config: BeamhopConfig): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface DoctorInput {
  config: BeamhopConfig | null;
  configFile?: string;
  configError?: string;
  /** Remote-only mode: check just this public URL. */
  url?: string;
  cwd: string;
}

const ok = (id: string, title: string, message: string, technical?: string): Finding => ({
  id,
  status: 'ok',
  title,
  message,
  ...(technical ? { technical } : {}),
});

const sameIp = (a: string, b: string) =>
  a.replace(/^::ffff:/, '').toLowerCase() === b.replace(/^::ffff:/, '').toLowerCase();

function publicDomains(config: BeamhopConfig): string[] {
  return acmeDomains(config).filter((d) => !d.endsWith('.localhost') && !d.endsWith('.local'));
}

function localBase(config: BeamhopConfig): string {
  const { hostname, port } = parseListen(config.node.listen);
  const host = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

// ───────────────────────────── individual checks ─────────────────────────────

function checkConfig(input: DoctorInput, now: number): Finding[] {
  if (input.configError || !input.config) {
    const f: Finding = {
      id: 'config.valid',
      status: 'fail',
      title: 'Settings file',
      message: 'The settings file has a mistake, so the server will not start.',
      technical: input.configError ?? 'no config',
    };
    const file = input.configFile;
    if (file && existsSync(file))
      f.fix = {
        description: `Move ${file} aside and write a fresh one with safe defaults`,
        async apply() {
          const aside = `${file}.broken-${now}`;
          renameSync(file, aside);
          writeFileSync(
            file,
            renderInitYaml(
              { domain: null, persona: 'public-social', storage: 'sqlite' },
              new Date(now).toISOString().slice(0, 10),
            ),
          );
          return `Saved the old file as ${aside} and wrote a new ${file}`;
        },
      };
    return [f];
  }
  const c = input.config;
  const out: Finding[] = [
    ok(
      'config.valid',
      'Settings file',
      input.configFile
        ? `${input.configFile} is valid.`
        : 'No settings file; using defaults and BEAMHOP_* variables.',
    ),
  ];
  if (c.relays.every((r) => r.hosts.includes('*')))
    out.push({
      id: 'config.domain',
      status: 'warn',
      title: 'Domain',
      message:
        'No domain is set, so the relay answers on every address and cannot get a certificate.',
      technical: 'relays[].hosts = ["*"]',
    });
  if (c.storage.driver === 'memory')
    out.push({
      id: 'config.storage',
      status: 'warn',
      title: 'Storage',
      message: 'Storage is set to memory: everything is lost on restart.',
      technical: 'storage.driver = memory',
    });
  if (c.storage.driver === 'postgres' && !c.storage.url)
    out.push({
      id: 'config.storage',
      status: 'fail',
      title: 'Storage',
      message: 'PostgreSQL is selected but no connection address is set.',
      technical: 'storage.url / BEAMHOP_STORAGE__URL missing',
    });
  return out;
}

async function checkDataDir(config: BeamhopConfig, probes: DoctorProbes): Promise<Finding[]> {
  const layout = dataLayout(config.node.dataDir);
  const out: Finding[] = [];
  if (!existsSync(layout.root)) {
    out.push({
      id: 'data.exists',
      status: 'warn',
      title: 'Data folder',
      message: `The data folder ${layout.root} does not exist yet.`,
      technical: 'created on first start',
      fix: {
        description: `Create ${layout.root} with private permissions`,
        async apply() {
          ensureDataDir(layout.root);
          return `Created ${layout.root}`;
        },
      },
    });
    return out;
  }
  const st = statSync(layout.root);
  let writable = true;
  try {
    const probe = resolve(layout.root, `.doctor-${process.pid}`);
    writeFileSync(probe, '');
    (await import('node:fs')).rmSync(probe);
  } catch {
    writable = false;
  }
  if (!writable)
    out.push({
      id: 'data.writable',
      status: 'fail',
      title: 'Data folder',
      message: `Beamhop cannot write to ${layout.root}.`,
      technical: `mode ${(st.mode & 0o777).toString(8)}, uid ${st.uid}; process uid ${process.getuid?.() ?? '?'}`,
    });
  else if (st.mode & 0o002)
    out.push({
      id: 'data.permissions',
      status: 'warn',
      title: 'Data folder',
      message: 'Anyone on this machine can change files in the data folder.',
      technical: `mode ${(st.mode & 0o777).toString(8)} is world-writable`,
      fix: {
        description: `Remove write access for others on ${layout.root}`,
        async apply() {
          chmodSync(layout.root, st.mode & 0o775);
          return `Fixed permissions on ${layout.root}`;
        },
      },
    });
  else out.push(ok('data.writable', 'Data folder', `${layout.root} is writable.`));
  if (existsSync(layout.secretsDir)) {
    const s = statSync(layout.secretsDir);
    if (s.mode & 0o077)
      out.push({
        id: 'data.secrets',
        status: 'warn',
        title: 'Keys folder',
        message: 'Other users on this machine can read the server’s keys.',
        technical: `${layout.secretsDir} mode ${(s.mode & 0o777).toString(8)} (want 700)`,
        fix: {
          description: `Make ${layout.secretsDir} private (owner only)`,
          async apply() {
            chmodSync(layout.secretsDir, 0o700);
            return `Made ${layout.secretsDir} private`;
          },
        },
      });
  }
  const disk = await probes.diskFree(layout.root);
  if (!disk)
    out.push({
      id: 'disk.free',
      status: 'skip',
      title: 'Disk space',
      message: 'Could not read the free disk space.',
    });
  else {
    const pct = disk.total ? disk.free / disk.total : 1;
    const tech = `${bytes(disk.free)} free of ${bytes(disk.total)} (${Math.round(pct * 100)}%)`;
    if (disk.free < 1024 ** 3)
      out.push({
        id: 'disk.free',
        status: 'fail',
        title: 'Disk space',
        message: 'The disk is almost full; the relay will stop saving posts and files soon.',
        technical: tech,
      });
    else if (disk.free < 5 * 1024 ** 3 || pct < 0.1)
      out.push({
        id: 'disk.free',
        status: 'warn',
        title: 'Disk space',
        message: 'Disk space is getting low.',
        technical: tech,
      });
    else out.push(ok('disk.free', 'Disk space', `${bytes(disk.free)} free.`, tech));
  }
  return out;
}

async function checkStorage(config: BeamhopConfig, probes: DoctorProbes): Promise<Finding[]> {
  const out: Finding[] = [];
  if (config.storage.driver !== 'memory') {
    const db = await probes.openDatabase(config);
    out.push(
      db.ok
        ? ok('storage.database', 'Database', 'The database opens fine.', db.detail)
        : {
            id: 'storage.database',
            status: 'fail',
            title: 'Database',
            message: 'The database cannot be opened.',
            technical: db.error,
          },
    );
  }
  if (config.blobStorage.driver !== 'memory') {
    const b = await probes.blobRoundTrip(config);
    out.push(
      b.ok
        ? ok(
            'storage.blobs',
            'Media storage',
            'Files can be saved, read back and deleted.',
            `blobStorage.driver = ${config.blobStorage.driver}`,
          )
        : {
            id: 'storage.blobs',
            status: 'fail',
            title: 'Media storage',
            message: 'Media files cannot be saved.',
            technical: b.error,
          },
    );
  }
  return out;
}

async function checkDns(domains: string[], probes: DoctorProbes): Promise<Finding[]> {
  if (!domains.length) return [];
  const mine = await probes.publicIps();
  const out: Finding[] = [];
  for (const d of domains) {
    let ips: string[] = [];
    try {
      ips = await probes.resolveDns(d);
    } catch (err) {
      out.push({
        id: `dns.${d}`,
        status: 'fail',
        title: `Domain ${d}`,
        message: `${d} does not exist in DNS yet. Add an A (and AAAA) record pointing to this server.`,
        technical: String(err),
      });
      continue;
    }
    if (!ips.length) {
      out.push({
        id: `dns.${d}`,
        status: 'fail',
        title: `Domain ${d}`,
        message: `${d} has no address records.`,
        technical: 'no A/AAAA',
      });
      continue;
    }
    const tech = `${d} → ${ips.join(', ')}; this host: ${mine.length ? mine.join(', ') : 'unknown'}`;
    if (!mine.length)
      out.push({
        id: `dns.${d}`,
        status: 'skip',
        title: `Domain ${d}`,
        message: `${d} resolves, but this server's public address is unknown (behind NAT or a proxy). Set BEAMHOP_PUBLIC_IP to check it.`,
        technical: tech,
      });
    else if (ips.some((ip) => mine.some((m) => sameIp(ip, m))))
      out.push(ok(`dns.${d}`, `Domain ${d}`, `${d} points to this server.`, tech));
    else
      out.push({
        id: `dns.${d}`,
        status: 'warn',
        title: `Domain ${d}`,
        message: `${d} points somewhere else (fine if a proxy or CDN sits in front; otherwise update the DNS record).`,
        technical: tech,
      });
  }
  return out;
}

async function checkTls(domains: string[], probes: DoctorProbes): Promise<Finding[]> {
  const out: Finding[] = [];
  const now = probes.now();
  for (const d of domains) {
    const cert = await probes.certificate(d, 443);
    if (!cert) {
      out.push({
        id: `tls.${d}`,
        status: 'warn',
        title: `Certificate for ${d}`,
        message: `Nothing answered securely on ${d}:443.`,
        technical: 'TLS connect failed',
      });
      continue;
    }
    const days = Math.floor((cert.validTo - now) / 86_400_000);
    const tech = `issuer ${cert.issuer ?? '?'}; names ${cert.names.join(', ')}; expires ${new Date(cert.validTo).toISOString()}${cert.error ? `; ${cert.error}` : ''}`;
    const covers = cert.names.some(
      (n) =>
        n === d ||
        (n.startsWith('*.') &&
          d.endsWith(n.slice(1)) &&
          d.split('.').length === n.split('.').length),
    );
    if (cert.validTo < now)
      out.push({
        id: `tls.${d}`,
        status: 'fail',
        title: `Certificate for ${d}`,
        message: 'The certificate has expired; apps will refuse to connect.',
        technical: tech,
      });
    else if (!covers)
      out.push({
        id: `tls.${d}`,
        status: 'fail',
        title: `Certificate for ${d}`,
        message: `The certificate is for a different name, so apps will refuse ${d}.`,
        technical: tech,
      });
    else if (!cert.trusted)
      out.push({
        id: `tls.${d}`,
        status: 'fail',
        title: `Certificate for ${d}`,
        message: 'The certificate is not trusted (self-signed or incomplete chain).',
        technical: tech,
      });
    else if (days < 14)
      out.push({
        id: `tls.${d}`,
        status: 'warn',
        title: `Certificate for ${d}`,
        message: `The certificate expires in ${days} day(s) and has not been renewed yet.`,
        technical: tech,
      });
    else out.push(ok(`tls.${d}`, `Certificate for ${d}`, `Valid for ${days} more days.`, tech));
  }
  return out;
}

async function checkReachability(
  config: BeamhopConfig | null,
  base: string,
  domains: string[],
  probes: DoctorProbes,
): Promise<Finding[]> {
  const out: Finding[] = [];
  const local = config ? localBase(config) : null;
  if (local) {
    const u = new URL(local);
    const open = await probes.portOpen(u.hostname, Number(u.port));
    out.push(
      open
        ? ok('port.listen', 'Server', `The server is answering on ${config!.node.listen}.`)
        : {
            id: 'port.listen',
            status: 'warn',
            title: 'Server',
            message: `Nothing is answering on ${config!.node.listen}. Start it with \`beamhop serve\` (the network checks below need it running).`,
            technical: `${local} not reachable`,
          },
    );
  }
  for (const d of domains) {
    for (const port of [443, 80]) {
      if (await probes.portOpen(d, port)) continue;
      out.push({
        id: `port.${d}.${port}`,
        status: port === 443 ? 'fail' : 'warn',
        title: `Port ${port}`,
        message:
          port === 443
            ? `${d} cannot be reached on port 443 from here. Open it in the firewall.`
            : `Port 80 on ${d} is closed; automatic certificates need it.`,
        technical: `TCP ${d}:${port} closed`,
      });
    }
  }
  const sc = await probes.selfCheckHttp(base);
  if (!sc) {
    out.push({
      id: 'proxy.selfcheck',
      status: 'skip',
      title: 'Proxy and WebSocket',
      message: `Could not reach ${base}; skipped proxy and WebSocket checks.`,
      technical: `${base}${SELF_CHECK_PATH}`,
    });
    return out;
  }
  if (sc.body.problems.length)
    for (const [i, p] of sc.body.problems.entries())
      out.push({
        id: `proxy.${i}`,
        status: 'warn',
        title: 'Proxy',
        message: p.message,
        technical: p.technical,
      });
  else
    out.push(
      ok(
        'proxy.headers',
        'Proxy',
        'Visitor details arrive correctly.',
        `tls=${sc.body.tls} trustProxy=${sc.body.trustProxy} proto=${sc.body.seen?.proto}`,
      ),
    );
  out.push(
    (await probes.selfCheckWs(base))
      ? ok('proxy.websocket', 'WebSocket', 'Apps can open live connections.')
      : {
          id: 'proxy.websocket',
          status: 'fail',
          title: 'WebSocket',
          message:
            'Live connections are blocked. Your proxy must pass WebSocket upgrades (Upgrade/Connection headers).',
          technical: `WS upgrade to ${base}${SELF_CHECK_PATH} failed`,
        },
  );
  if (sc.date !== undefined) {
    const skew = Math.round((probes.now() - sc.date) / 1000);
    const tech = `local clock ${skew > 0 ? 'ahead' : 'behind'} by ${Math.abs(skew)}s (HTTP Date header)`;
    if (Math.abs(skew) > 300)
      out.push({
        id: 'clock.skew',
        status: 'fail',
        title: 'Clock',
        message:
          'This computer’s clock is more than 5 minutes off; sign-ins and posts will be rejected.',
        technical: tech,
      });
    else if (Math.abs(skew) > 30)
      out.push({
        id: 'clock.skew',
        status: 'warn',
        title: 'Clock',
        message:
          'This computer’s clock is off by more than 30 seconds. Turn on automatic time (NTP).',
        technical: tech,
      });
    else out.push(ok('clock.skew', 'Clock', 'The clock is accurate.', tech));
  }
  return out;
}

/** Run every check. Pure apart from the probes (and fixes, which only run when applied). */
export async function runDoctor(input: DoctorInput, probes: DoctorProbes): Promise<Finding[]> {
  const findings: Finding[] = [];
  if (input.url) {
    const host = new URL(input.url).hostname;
    const isIp = /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[');
    if (!isIp) findings.push(...(await checkDns([host], probes)));
    findings.push(
      ...(await checkTls(new URL(input.url).protocol === 'https:' ? [host] : [], probes)),
    );
    findings.push(...(await checkReachability(null, input.url.replace(/\/+$/, ''), [], probes)));
    return findings;
  }
  findings.push(...checkConfig(input, probes.now()));
  const config = input.config;
  if (!config) return findings;
  const cfg = withDataDirDefaults(config, dataLayout(config.node.dataDir));
  findings.push(...(await checkDataDir(cfg, probes)));
  if (existsSync(cfg.node.dataDir)) findings.push(...(await checkStorage(cfg, probes)));
  const domains = publicDomains(cfg);
  const dns = await checkDns(domains, probes);
  findings.push(...dns);
  // Domains that do not resolve make every later network check fail; skip them.
  const live = domains.filter((d) => dns.find((f) => f.id === `dns.${d}`)?.status !== 'fail');
  const tlsMode = cfg.node.tls.mode;
  if (tlsMode !== 'off') findings.push(...(await checkTls(live, probes)));
  const base = live[0] ? `https://${live[0]}` : localBase(cfg);
  findings.push(...(await checkReachability(cfg, base, tlsMode === 'off' ? [] : live, probes)));
  return findings;
}

export function doctorExitCode(findings: Finding[]): number {
  if (findings.some((f) => f.status === 'fail')) return EXIT.error;
  if (findings.some((f) => f.status === 'warn')) return EXIT.warnings;
  return EXIT.ok;
}

// ───────────────────────────── default probes (real I/O) ─────────────────────────────

export function defaultProbes(ctx: CliContext): DoctorProbes {
  const env = ctx.env;
  return {
    now: () => ctx.now(),
    async resolveDns(host) {
      const { lookup } = await import('node:dns/promises');
      return (await lookup(host, { all: true })).map((a) => a.address);
    },
    async publicIps() {
      const fromEnv = (env.BEAMHOP_PUBLIC_IP ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return fromEnv.length ? fromEnv : localPublicIps();
    },
    certificate(host, port) {
      return new Promise((done) => {
        import('node:tls').then(
          (tls) => {
            const sock = tls.connect(
              { host, port, servername: host, rejectUnauthorized: false, timeout: 5000 },
              () => {
                const c = sock.getPeerCertificate();
                const names = [
                  ...String(c?.subjectaltname ?? '')
                    .split(',')
                    .map((s) => s.trim().replace(/^DNS:/, ''))
                    .filter(Boolean),
                ];
                if (!names.length && c?.subject?.CN) names.push(String(c.subject.CN));
                const info: CertInfo = {
                  validFrom: Date.parse(c?.valid_from ?? ''),
                  validTo: Date.parse(c?.valid_to ?? ''),
                  issuer: [c?.issuer?.O ?? c?.issuer?.CN].flat()[0],
                  names,
                  trusted: sock.authorized,
                };
                if (sock.authorizationError) info.error = String(sock.authorizationError);
                sock.end();
                done(c?.valid_to ? info : null);
              },
            );
            sock.on('error', () => done(null));
            sock.on('timeout', () => {
              sock.destroy();
              done(null);
            });
          },
          () => done(null),
        );
      });
    },
    portOpen(host, port) {
      return new Promise((done) => {
        import('node:net').then(
          (net) => {
            const s = net.connect({ host, port, timeout: 3000 }, () => {
              s.end();
              done(true);
            });
            s.on('error', () => done(false));
            s.on('timeout', () => {
              s.destroy();
              done(false);
            });
          },
          () => done(false),
        );
      });
    },
    async selfCheckHttp(base) {
      try {
        const res = await ctx.fetch(`${base}${SELF_CHECK_PATH}?nonce=doctor`, {
          signal: AbortSignal.timeout(5000),
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        if (!res.ok) return null;
        const date = Date.parse(res.headers.get('date') ?? '');
        const r: { body: SelfCheckResult; date?: number } = {
          body: (await res.json()) as SelfCheckResult,
        };
        if (Number.isFinite(date)) r.date = date;
        return r;
      } catch {
        return null;
      }
    },
    selfCheckWs(base) {
      return new Promise((done) => {
        let settled = false;
        const finish = (v: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          done(v);
        };
        const timer = setTimeout(() => finish(false), 5000);
        try {
          const ws = new WebSocket(`${base.replace(/^http/, 'ws')}${SELF_CHECK_PATH}?nonce=doctor`);
          ws.onmessage = (m) => {
            try {
              finish(JSON.parse(String(m.data)).type === 'beamhop-self-check');
            } catch {
              finish(false);
            }
            ws.close();
          };
          ws.onerror = () => finish(false);
        } catch {
          finish(false);
        }
      });
    },
    async diskFree(path) {
      try {
        const { statfsSync } = await import('node:fs');
        const s = statfsSync(path);
        return {
          free: Number(s.bavail) * Number(s.bsize),
          total: Number(s.blocks) * Number(s.bsize),
        };
      } catch {
        return null;
      }
    },
    async openDatabase(config) {
      try {
        if (config.storage.driver === 'sqlite') {
          const path = sqlitePathOf(config);
          if (!existsSync(path))
            return { ok: true, detail: `${path} will be created on first start` };
          const db = new Database(path, { readonly: true });
          try {
            const r = db.query<{ quick_check: string }, []>('PRAGMA quick_check').get();
            if (r?.quick_check !== 'ok')
              return { ok: false, error: `quick_check: ${r?.quick_check}` };
            return { ok: true, detail: `${path} (quick_check ok)` };
          } finally {
            db.close();
          }
        }
        const { createSqlStores } = await import('@beamhop/storage-sql');
        const stores = await createSqlStores({
          driver: config.storage.driver as 'postgres',
          url: config.storage.url,
          dataDir: config.node.dataDir,
          logger: cliLogger(env),
        } as never);
        await (stores as { close?: () => Promise<void> | void }).close?.();
        return { ok: true, detail: `${config.storage.driver} connected` };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    async blobRoundTrip(config) {
      try {
        const { createBlobStore } = await import('@beamhop/blobs');
        const store = await createBlobStore({
          ...config.blobStorage,
          dataDir: config.node.dataDir,
        });
        await store.init();
        const data = new TextEncoder().encode(`beamhop doctor probe ${ctx.now()} ${Math.random()}`);
        const sha256 = new Bun.CryptoHasher('sha256').update(data).digest('hex');
        await store.put(
          {
            sha256,
            size: data.length,
            type: 'text/plain',
            uploadedAt: Math.floor(ctx.now() / 1000),
          } as never,
          data,
        );
        const got = await store.get(sha256);
        if (!got) return { ok: false, error: 'wrote a probe file but could not read it back' };
        await store.delete(sha256);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  };
}

// ───────────────────────────── command ─────────────────────────────

function loadInput(ctx: CliContext, globals: FlagValues): DoctorInput {
  const input: DoctorInput = { config: null, cwd: ctx.cwd };
  const url = str(globals.url);
  if (url) {
    input.url = url.includes('://') ? url : `https://${url}`;
    return input;
  }
  try {
    const loaded = resolveLocalConfig(localOptions(ctx, globals));
    input.config = loaded.config;
    if (loaded.file) input.configFile = loaded.file;
  } catch (err) {
    input.configError = (err as { technical?: string }).technical ?? String(err);
    input.configFile = resolve(ctx.cwd, str(globals.config) ?? 'beamhop.yaml');
  }
  return input;
}

const FLAGS: FlagSpec[] = [
  { name: 'fix', type: 'boolean', description: 'Offer the safe one-step fixes' },
];

export async function doctorCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
  probes: DoctorProbes = defaultProbes(ctx),
): Promise<number> {
  const { io } = ctx;
  const p = paint(io);
  const { flags } = parseFlags(argv, FLAGS);
  if (bool(globals.help)) {
    io.out(
      'Check this setup: settings, data folder, disk, database, media storage, DNS, certificate, ports, proxy, WebSocket and clock.\n\nUsage: beamhop doctor [--fix] [--yes] [--json] [--technical] [--url <public url>]\n\nExit codes: 0 all good, 4 warnings, 1 problems.\n',
    );
    return EXIT.ok;
  }
  const input = loadInput(ctx, globals);
  let findings = await runDoctor(input, probes);
  if (bool(globals.json)) {
    json(io, {
      findings: findings.map(({ fix, ...f }) => ({ ...f, fixable: !!fix, fix: fix?.description })),
      exitCode: doctorExitCode(findings),
    });
    return doctorExitCode(findings);
  }
  const technical = bool(globals.technical);
  const mark: Record<FindingStatus, string> = {
    ok: p.green('✓'),
    warn: p.yellow('!'),
    fail: p.red('✗'),
    skip: p.dim('-'),
  };
  for (const f of findings) {
    line(io, `${mark[f.status]} ${p.bold(f.title)}: ${f.message}`);
    if (technical && f.technical) line(io, p.dim(`    ${f.technical}`));
    if (f.fix && !bool(flags.fix))
      line(io, p.dim(`    Fix: ${f.fix.description} (run \`beamhop doctor --fix\`)`));
  }
  if (bool(flags.fix)) {
    const fixable = findings.filter((f) => f.fix && f.status !== 'ok');
    let applied = 0;
    for (const f of fixable) {
      let go = bool(globals.yes);
      if (!go && io.interactive)
        go = /^y(es)?$/i.test(
          (await io.prompt(`Fix “${f.title}”: ${f.fix!.description}? (y/N)`)).trim(),
        );
      if (!go) continue;
      try {
        line(io, `${p.green('✓')} ${await f.fix!.apply()}`);
        applied++;
      } catch (err) {
        line(io, `${p.red('✗')} Could not fix “${f.title}”: ${String(err)}`);
      }
    }
    if (!fixable.length) line(io, 'Nothing here can be fixed automatically.');
    else if (!applied && !io.interactive && !bool(globals.yes))
      line(io, 'Run with --fix --yes to apply the fixes without questions.');
    if (applied) {
      findings = await runDoctor(loadInput(ctx, globals), probes);
      line(
        io,
        p.dim(
          `After fixes: ${findings.filter((f) => f.status === 'fail').length} problem(s), ${findings.filter((f) => f.status === 'warn').length} warning(s).`,
        ),
      );
    }
  }
  const code = doctorExitCode(findings);
  line(
    io,
    code === EXIT.ok
      ? p.green('\nAll checks passed.')
      : code === EXIT.warnings
        ? p.yellow('\nWorking, with warnings.')
        : p.red('\nSome things need fixing.'),
  );
  return code;
}
