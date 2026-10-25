import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { schnorrOk } from "./schnorr";

type Item = [id: string, pubkey: string, sig: string];

interface Job {
  item: Item;
  resolve: (ok: boolean) => void;
}

interface Slot {
  worker: Worker;
  /** batches sent and not answered yet, by message id */
  pending: Map<number, Job[]>;
  /** signatures in those batches */
  load: number;
}

/** Signatures per message to a worker: a postMessage costs tens of µs, a signature ~200 µs. */
export const VERIFY_BATCH_MAX = 64;
/** Workers that died this many times disable the pool: verification then runs on the main thread again. */
const MAX_WORKER_FAILURES = 5;

let workerPath: string | undefined;

/** The compiled binary embeds the worker under its path relative to the build root (set by scripts/build-binary.ts). */
export function setVerifyWorkerPath(spec: string) {
  workerPath = spec;
}

/**
 * The worker script next to this module: verify-worker.js in the node bundle and the compiled binary (built as its
 * own entry point), verify-worker.ts when running from source.
 */
export function verifyWorkerUrl(): URL | string | undefined {
  if (workerPath) return workerPath;
  for (const name of ["./verify-worker.js", "./verify-worker.ts"]) {
    const url = new URL(name, import.meta.url);
    try {
      if (existsSync(fileURLToPath(url))) return url;
    } catch {
      /* not a file: URL */
    }
  }
  return undefined;
}

/**
 * Schnorr verification on worker threads, so a burst of EVENTs doesn't hold the event loop (~200 µs each in JS) and
 * uses more than one core. Requests made in the same tick are sent in batches, spread over the least loaded
 * workers; workers start on demand and don't keep the process alive. Whenever no worker can take a batch (none could
 * be started, one died with batches in flight, the pool was closed), those signatures are checked on the main
 * thread instead, so a verification never fails because of the pool.
 */
export class VerifyPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private scheduled = false;
  private nextId = 0;
  private failures = 0;
  private closed = false;

  constructor(
    private size: number,
    /** the worker script; null verifies on the main thread */
    private readonly url: URL | string | null = verifyWorkerUrl() ?? null,
    private readonly onError?: (msg: string, err?: unknown) => void,
  ) {}

  /** workers running */
  get workers() {
    return this.slots.length;
  }

  /** Raises the pool size (several relays in one process share a pool). */
  grow(size: number) {
    this.size = Math.max(this.size, size);
  }

  verify(id: string, pubkey: string, sig: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.queue.push({ item: [id, pubkey, sig], resolve });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  /** Stops the workers; signatures still in flight are checked on the main thread. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
  }

  private flush() {
    this.scheduled = false;
    const jobs = this.queue;
    this.queue = [];
    const per = Math.max(1, Math.min(VERIFY_BATCH_MAX, Math.ceil(jobs.length / Math.max(1, this.size))));
    for (let i = 0; i < jobs.length; i += per) {
      const batch = jobs.slice(i, i + per);
      const slot = this.pick();
      if (!slot) {
        for (const j of batch) j.resolve(schnorrOk(...j.item));
        continue;
      }
      const id = this.nextId++;
      slot.pending.set(id, batch);
      slot.load += batch.length;
      slot.worker.postMessage({ id, items: batch.map((j) => j.item) });
    }
  }

  /** The least loaded worker, starting another while all are busy and the pool isn't full. */
  private pick(): Slot | undefined {
    if (this.closed || this.failures >= MAX_WORKER_FAILURES) return undefined;
    let best: Slot | undefined;
    for (const s of this.slots) if (!best || s.load < best.load) best = s;
    if ((!best || best.load > 0) && this.slots.length < this.size) return this.spawn() ?? best;
    return best;
  }

  private spawn(): Slot | undefined {
    if (!this.url) return undefined;
    let worker: Worker;
    try {
      worker = new Worker(this.url);
    } catch (err) {
      this.failed("could not start a signature verification worker", err);
      return undefined;
    }
    worker.unref();
    const slot: Slot = { worker, pending: new Map(), load: 0 };
    worker.on("message", (msg: { id: number; ok: boolean[] }) => {
      const batch = slot.pending.get(msg.id);
      if (!batch) return;
      slot.pending.delete(msg.id);
      slot.load -= batch.length;
      batch.forEach((j, i) => j.resolve(msg.ok[i] === true));
    });
    const gone = (err?: unknown) => {
      const i = this.slots.indexOf(slot);
      if (i < 0) return;
      this.slots.splice(i, 1);
      if (!this.closed) this.failed("signature verification worker died", err);
      for (const batch of slot.pending.values()) for (const j of batch) j.resolve(schnorrOk(...j.item));
      slot.pending.clear();
      slot.load = 0;
    };
    worker.on("error", (err) => gone(err));
    worker.on("exit", () => gone());
    this.slots.push(slot);
    return slot;
  }

  private failed(msg: string, err?: unknown) {
    this.failures++;
    this.onError?.(this.failures >= MAX_WORKER_FAILURES ? `${msg}; verifying on the main thread from now on` : msg, err);
  }
}

let shared: VerifyPool | undefined;

/** The process-wide pool (created on first use, grown to the largest size asked for); undefined for size 0. */
export function sharedVerifyPool(size: number, onError?: (msg: string, err?: unknown) => void): VerifyPool | undefined {
  if (size <= 0) return undefined;
  if (shared) shared.grow(size);
  else shared = new VerifyPool(size, verifyWorkerUrl() ?? null, onError);
  return shared;
}
