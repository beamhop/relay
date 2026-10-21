// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline checks for the deploy templates: they parse, the platform-specific TLS defaults are
 * right, every env var maps to a real config path, and the GCP templates render to valid
 * cloud-init YAML + a bash script (a tiny stand-in for Terraform's templatefile()).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseConfig } from '../../packages/core/src/index.ts';
import { envToConfig } from '../../packages/runtime-bun/src/config.ts';

// biome-ignore lint/suspicious/noExplicitAny: parsed third-party config files are untyped
type J = any;

const ROOT = resolve(import.meta.dir, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const yaml = (p: string) => Bun.YAML.parse(read(p)) as J;
const toml = (p: string) => Bun.TOML.parse(read(p)) as J;

/** Env vars must produce a valid config (catches typos such as BEAMHOP_NODE__TRUSTPROXY). */
function validEnv(env: Record<string, string>) {
  const cfg = parseConfig(envToConfig(env));
  return cfg;
}

describe('PaaS templates run Beamhop in proxy mode on a volume', () => {
  test('fly.toml', () => {
    const t = toml('deploy/fly/fly.toml');
    expect(t.http_service.internal_port).toBe(3334);
    expect(t.http_service.auto_stop_machines).toBe('off');
    expect(t.http_service.checks[0].path).toBe('/healthz');
    expect(t.mounts[0].destination).toBe('/data');
    const cfg = validEnv(t.env);
    expect(cfg.node.tls.mode).toBe('proxy');
    expect(cfg.node.trustProxy).toBe(true);
  });

  test('render.yaml', () => {
    const svc = yaml('deploy/render/render.yaml').services[0];
    expect(svc.healthCheckPath).toBe('/healthz');
    expect(svc.disk.mountPath).toBe('/data');
    expect(svc.numInstances).toBe(1);
    const env = Object.fromEntries(
      svc.envVars.filter((e: J) => e.value).map((e: J) => [e.key, e.value]),
    );
    expect(validEnv(env).node.tls.mode).toBe('proxy');
  });

  test('railway.json', () => {
    const r = JSON.parse(read('deploy/railway/railway.json'));
    expect(r.build.dockerfilePath).toBe('deploy/Dockerfile');
    expect(r.deploy.healthcheckPath).toBe('/healthz');
    expect(r.deploy.numReplicas).toBe(1);
  });

  test('DigitalOcean App Platform spec uses Postgres + Spaces (no disks there)', () => {
    const app = yaml('deploy/digitalocean/app.yaml');
    const svc = app.services[0];
    expect(svc.http_port).toBe(3334);
    expect(svc.health_check.http_path).toBe('/healthz');
    expect(app.databases[0].engine).toBe('PG');
    const env = Object.fromEntries(
      svc.envs.filter((e: J) => !String(e.value).startsWith('${')).map((e: J) => [e.key, e.value]),
    );
    const cfg = validEnv(env);
    expect(cfg.storage.driver).toBe('postgres');
    expect(cfg.blobStorage.driver).toBe('s3');
  });
});

describe('VM templates', () => {
  for (const f of ['deploy/digitalocean/cloud-init.yaml', 'deploy/hetzner/cloud-init.yaml'])
    test(f, () => {
      expect(read(f).startsWith('#cloud-config\n')).toBe(true);
      const c = yaml(f);
      expect(c.runcmd).toContain('sh /root/beamhop-install.sh');
      const script = c.write_files[0].content as string;
      expect(script).toContain('get.beamhop.dev');
      expect(
        Bun.spawnSync(['sh', '-n'], { stdin: new TextEncoder().encode(script) }).exitCode,
      ).toBe(0);
    });

  test('shell scripts parse', () => {
    for (const f of [
      'deploy/digitalocean/marketplace/install.sh',
      'deploy/digitalocean/marketplace/99-beamhop-motd',
    ])
      expect(Bun.spawnSync(['sh', '-n', join(ROOT, f)]).exitCode).toBe(0);
  });
});

/** Minimal templatefile(): ${var}, ${indent(n, var)}, %{ if var ~} … %{ endif ~}. */
function render(text: string, vars: Record<string, string | boolean>): string {
  let out = text.replace(
    /%\{ if (\w+) ~\}\n?([\s\S]*?)%\{ endif ~\}\n?/g,
    (_m, v: string, body: string) => (vars[v] ? body : ''),
  );
  out = out.replace(/\$\{indent\((\d+), (\w+)\)\}/g, (_m, n: string, v: string) =>
    String(vars[v]).replace(/\n/g, `\n${' '.repeat(Number(n))}`),
  );
  out = out.replace(/\$\{(\w+)\}/g, (_m, v: string) => {
    if (!(v in vars)) throw new Error(`template variable not passed: ${v}`);
    return String(vars[v]);
  });
  return out.replace(/\$\$\{/g, '${');
}

describe('GCP Terraform module', () => {
  const env = [
    'BEAMHOP_DATA_DIR=/data',
    'BEAMHOP_LISTEN=0.0.0.0:3334',
    'BEAMHOP_ACME_HTTP_PORT=3380',
    'BEAMHOP_DOMAIN=relay.example.com',
    'BEAMHOP_NODE__TLS__MODE=acme',
  ].join('\n');

  for (const litestream of [true, false])
    test(`cloud-init + startup script render (litestream=${litestream})`, () => {
      const ci = render(read('deploy/gcp/cloud-init.yaml.tftpl'), {
        image: 'ghcr.io/beamhop/beamhop:latest',
        env_file: env,
        litestream,
        litestream_bucket: 'b',
        litestream_image: 'litestream/litestream:0.3.13',
      });
      const parsed = Bun.YAML.parse(ci) as J;
      const files = parsed.write_files.map((f: J) => f.path);
      expect(files).toContain('/etc/systemd/system/beamhop.service');
      expect(files.includes('/etc/beamhop/litestream.yml')).toBe(litestream);
      const envFile = parsed.write_files.find((f: J) => f.path === '/etc/beamhop/beamhop.env');
      const vars = Object.fromEntries(
        (envFile.content as string)
          .trim()
          .split('\n')
          .map((l) => l.split('=') as [string, string]),
      );
      expect(vars.BEAMHOP_DOMAIN).toBe('relay.example.com');
      expect(validEnv(vars).node.tls.mode).toBe('acme');
      if (litestream) {
        const ls = parsed.write_files.find((f: J) => f.path === '/etc/beamhop/litestream.yml');
        expect((Bun.YAML.parse(ls.content) as J).dbs[0].replicas[0].type).toBe('gcs');
      }
      const unit = parsed.write_files.find(
        (f: J) => f.path === '/etc/systemd/system/beamhop.service',
      ).content as string;
      expect(unit).toContain('-p 443:3334 -p 80:3380');

      const startup = render(read('deploy/gcp/startup.sh.tftpl'), {
        image: 'x',
        litestream,
        litestream_image: 'litestream/litestream:0.3.13',
      });
      const bash = Bun.which('bash') ?? 'sh';
      expect(
        Bun.spawnSync([bash, '-n'], { stdin: new TextEncoder().encode(startup) }).exitCode,
      ).toBe(0);
      expect(startup.includes('beamhop-litestream')).toBe(litestream);
    });

  test('every templatefile() variable is passed by main.tf', () => {
    const main = read('deploy/gcp/main.tf');
    for (const f of readdirSync(join(ROOT, 'deploy/gcp')).filter((n) => n.endsWith('.tftpl'))) {
      const used = new Set(
        [...read(`deploy/gcp/${f}`).matchAll(/\$\{(?:indent\(\d+, )?(\w+)\)?\}|%\{ if (\w+)/g)].map(
          (m) => m[1] ?? m[2],
        ),
      );
      const call = main.slice(main.indexOf(`/${f}"`));
      const block = call.slice(0, call.indexOf('})'));
      for (const v of used) expect(block).toContain(`${v} `);
    }
  });

  test('HCL braces balance and every var is declared', () => {
    const files = ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf'].map((f) =>
      read(`deploy/gcp/${f}`),
    );
    for (const f of files) {
      expect((f.match(/\{/g) ?? []).length).toBe((f.match(/\}/g) ?? []).length);
      expect((f.match(/\[/g) ?? []).length).toBe((f.match(/\]/g) ?? []).length);
    }
    const declared = new Set([...files[1]!.matchAll(/variable "(\w+)"/g)].map((m) => m[1]));
    for (const f of [files[0]!, files[2]!])
      for (const m of f.matchAll(/var\.(\w+)/g)) expect(declared.has(m[1])).toBe(true);
  });
});

describe('HA kit', () => {
  test('compose and litestream configs parse; env maps to real settings', () => {
    const c = yaml('deploy/ha/compose.yaml');
    expect(Object.keys(c.services)).toEqual(['beamhop', 'litestream']);
    expect(c.services.beamhop.profiles).toEqual(['primary']);
    const env = {
      ...c.services.beamhop.environment,
      BEAMHOP_DOMAIN: 'relay.example.com',
      BEAMHOP_NODE__TLS__MODE: 'acme',
      BEAMHOP_NODE__TLS__EMAIL: '',
    };
    const cfg = validEnv(env);
    expect((cfg.modules.lifecycle as J).litestream.enabled).toBe(true);
    expect((cfg.modules.lifecycle as J).litestream.metricsUrl).toBe(
      'http://litestream:9090/metrics',
    );
    for (const f of ['deploy/ha/litestream.yml', 'deploy/ha/systemd/litestream.yml'])
      expect(yaml(f).dbs[0].path).toMatch(/db\/beamhop\.sqlite$/);
  });

  test('release workflow parses', () => {
    const wf = yaml('.github/workflows/release.yml');
    expect(Object.keys(wf.jobs)).toEqual(['binaries', 'image', 'publish']);
    expect(wf.jobs.publish.needs).toEqual(['binaries', 'image']);
    const build = wf.jobs.image.steps.find((s: J) => s.id === 'build');
    expect(build.with.platforms).toBe('linux/amd64,linux/arm64');
  });

  test('wrangler.toml for get.beamhop.dev parses', () => {
    expect(toml('deploy/get.beamhop.dev/wrangler.toml').main).toBe('worker.ts');
  });
});
