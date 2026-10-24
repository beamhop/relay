import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { HttpError } from "../errors";

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** OWASP's scrypt recommendation (~128 MiB per hash). Stored hashes carry their own parameters, so older ones still verify. */
export const SCRYPT_DEFAULTS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const KEYLEN = 64;
/** stored hashes whose parameters need more memory than this are refused instead of computed */
const MAX_MEM = 256 * 1024 * 1024;
/** scrypt's working set (128·r·(N + p) bytes) plus slack: node/BoringSSL refuse a maxmem of exactly 128·N·r */
const memFor = ({ N, r, p }: ScryptParams) => 128 * r * (N + p) + 1024 * 1024;

const scrypt = (pw: string, salt: Buffer, keylen: number, params: ScryptParams) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCb(pw.normalize("NFKC"), salt, keylen, { N: params.N, r: params.r, p: params.p, maxmem: memFor(params) }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );

/** Parses `scrypt$N$r$p$<salt b64>$<hash b64>`; undefined when malformed or too expensive to compute. */
function parse(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return undefined;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((x) => Number.isInteger(x) && x > 0) || N < 2 || (N & (N - 1)) !== 0) return undefined;
  const params = { N, r, p };
  if (memFor(params) > MAX_MEM) return undefined;
  const hash = Buffer.from(parts[5], "base64");
  return hash.length ? { params, salt: Buffer.from(parts[4], "base64"), hash } : undefined;
}

/** Counting semaphore with a bounded wait queue; callers beyond the queue get 503 `busy`. */
class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(
    private readonly max: number,
    private readonly queue: number,
  ) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.max) this.active++;
    else if (this.waiting.length < this.queue) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else throw new HttpError(503, "too many password checks in progress, try again shortly", "busy", { "Retry-After": "1" });
    try {
      return await fn();
    } finally {
      // hand the slot straight to the next waiter (if any) so it can't be overtaken
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

export interface PasswordHasherOptions {
  /** parameters for new hashes (tests use cheaper ones) */
  params?: ScryptParams;
  /** hashes / verifies running at once (each holds ~128 MiB at the defaults) */
  concurrency?: number;
  /** callers allowed to wait for a slot before the rest are answered `busy` */
  queue?: number;
}

/**
 * scrypt password hashing with bounded memory: at most `concurrency` hashes or verifies run at once and at most `queue`
 * more wait, so a burst of logins answers 503 `busy` instead of exhausting memory.
 */
export class PasswordHasher {
  readonly params: ScryptParams;
  private readonly gate: Gate;
  private dummy: Promise<string> | undefined;

  constructor(o: PasswordHasherOptions = {}) {
    this.params = { ...(o.params ?? SCRYPT_DEFAULTS) };
    this.gate = new Gate(o.concurrency ?? 2, o.queue ?? 8);
  }

  /** Format: `scrypt$N$r$p$<salt b64>$<hash b64>` */
  hash(password: string): Promise<string> {
    const { N, r, p } = this.params;
    return this.gate.run(async () => {
      const salt = randomBytes(16);
      const key = await scrypt(password, salt, KEYLEN, this.params);
      return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
    });
  }

  verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return Promise.resolve(false);
    return this.gate.run(async () => {
      const key = await scrypt(password, parsed.salt, parsed.hash.length, parsed.params);
      return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
    });
  }

  /** True when `stored` was made with other parameters than the current ones (rehash it after a successful login). */
  needsRehash(stored: string): boolean {
    const p = parse(stored)?.params;
    return !p || p.N !== this.params.N || p.r !== this.params.r || p.p !== this.params.p;
  }

  /** Hash of a random password, verified against when the login does not exist (equal timing). */
  dummyHash(): Promise<string> {
    return (this.dummy ??= this.hash(randomBytes(16).toString("hex")).catch((err) => {
      this.dummy = undefined; // e.g. busy: try again next time
      throw err;
    }));
  }
}

const shared = new PasswordHasher();
/** Hashes with the default parameters (also used by the CLI). */
export const hashPassword = (password: string) => shared.hash(password);
export const verifyPassword = (password: string, stored: string) => shared.verify(password, stored);
