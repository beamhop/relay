// SPDX-License-Identifier: AGPL-3.0-or-later
/** Command-line argument parsing for the conformance CLI. */

export const USAGE = `Usage: conformance <wss://relay.example> [options]

Checks a Nostr relay (and optionally a Blossom media server) against the NIPs
and BUDs it claims to support. Checks for features the relay does not list in
its NIP-11 document are skipped.

Options:
  --blossom <url>        Also check this Blossom media server (BUD-01/02/04/05/06)
  --nips <1,9,11,...>    Only run checks for these NIPs
  --buds <1,2,...>       Only run these Blossom checks
  --only <id,...>        Only run checks whose id starts with one of these (e.g. nip01.req)
  --fuzz <n>             Also send n malformed messages and check the relay survives
  --seed <n>             Fuzz seed (to reproduce a run)
  --timeout <ms>         Wait this long for each answer (default 5000)
  --json                 Print the report as JSON instead of text
  --out <file>           Also write the JSON report to a file
  --badge [file]         Write an SVG badge (default conformance-badge.svg)
  --all                  Also run checks for NIPs the relay does not advertise
  --allow-private-mirror Run the BUD-04 mirror check even for private addresses
  --no-color             Plain output
  -h, --help             Show this help

Exit code: 0 when nothing failed, 1 when a check failed, 2 on usage errors.
`;

export interface CliOptions {
  relayUrl: string;
  blossomUrl?: string;
  nips?: number[];
  buds?: number[];
  only?: string[];
  fuzz?: number;
  seed?: number;
  timeoutMs?: number;
  json: boolean;
  out?: string;
  badge?: string;
  allowPrivateMirror: boolean;
  all: boolean;
  color: boolean;
  help: boolean;
}

export class UsageError extends Error {}

function numList(v: string | undefined, flag: string): number[] {
  if (!v) throw new UsageError(`${flag} needs a value`);
  const out = v.split(',').map((s) => Number.parseInt(s.trim().replace(/^(nip|bud)-?/i, ''), 10));
  if (out.some((n) => !Number.isInteger(n) || n < 0))
    throw new UsageError(`${flag}: expected numbers like 1,9,11`);
  return out;
}

function int(v: string | undefined, flag: string): number {
  const n = Number(v);
  if (v === undefined || !Number.isInteger(n) || n < 0)
    throw new UsageError(`${flag} needs a whole number`);
  return n;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = {
    relayUrl: '',
    json: false,
    allowPrivateMirror: false,
    all: false,
    color: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [flag, inline] = a.startsWith('--') && a.includes('=') ? a.split(/=(.*)/s, 2) : [a];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    switch (flag) {
      case '-h':
      case '--help':
        o.help = true;
        break;
      case '--blossom':
        o.blossomUrl = value();
        if (!o.blossomUrl) throw new UsageError('--blossom needs a URL');
        break;
      case '--nips':
        o.nips = numList(value(), '--nips');
        break;
      case '--buds':
        o.buds = numList(value(), '--buds');
        break;
      case '--only': {
        const v = value();
        if (!v) throw new UsageError('--only needs a value');
        o.only = v.split(',').map((s) => s.trim());
        break;
      }
      case '--fuzz':
        o.fuzz = int(value(), '--fuzz');
        break;
      case '--seed':
        o.seed = int(value(), '--seed');
        break;
      case '--timeout':
        o.timeoutMs = int(value(), '--timeout');
        break;
      case '--json':
        o.json = true;
        break;
      case '--out':
        o.out = value();
        if (!o.out) throw new UsageError('--out needs a file name');
        break;
      case '--badge': {
        if (inline !== undefined) o.badge = inline;
        else if (argv[i + 1] && !argv[i + 1]!.startsWith('-') && argv[i + 1]!.endsWith('.svg'))
          o.badge = argv[++i];
        else o.badge = 'conformance-badge.svg';
        break;
      }
      case '--all':
        o.all = true;
        break;
      case '--allow-private-mirror':
        o.allowPrivateMirror = true;
        break;
      case '--no-color':
        o.color = false;
        break;
      default:
        if (a.startsWith('-')) throw new UsageError(`Unknown option ${a}`);
        if (o.relayUrl) throw new UsageError(`Unexpected argument ${a}`);
        o.relayUrl = a;
    }
  }
  if (o.help) return o;
  if (!o.relayUrl) throw new UsageError('Give the relay address, e.g. wss://relay.example');
  if (!/^wss?:\/\//i.test(o.relayUrl))
    throw new UsageError('The relay address must start with ws:// or wss://');
  if (o.blossomUrl && !/^https?:\/\//i.test(o.blossomUrl))
    throw new UsageError('The media server address must start with http:// or https://');
  return o;
}
