/**
 * Negentropy protocol v1 (NIP-77), written after the reference implementation by Doug Hoyte
 * (https://github.com/hoytech/negentropy, MIT). Supports both initiator (client) and responder (relay) roles.
 */
import { createHash } from "node:crypto";
import { bytesToHex, hexToBytes } from "../../util/hex";

export const PROTOCOL_VERSION = 0x61;
export const ID_SIZE = 32;
const FINGERPRINT_SIZE = 16;
const BUCKETS = 16;
const DOUBLE_BUCKETS = BUCKETS * 2;
/** Timestamp used for the "infinity" bound */
export const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

const enum Mode {
  Skip = 0,
  Fingerprint = 1,
  IdList = 2,
}

export interface Item {
  timestamp: number;
  id: Uint8Array;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

// ------------------------------------------------------------------ byte buffers

class WriteBuffer {
  private buf = new Uint8Array(512);
  length = 0;
  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.length + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
  }
  byte(b: number) {
    this.ensure(1);
    this.buf[this.length++] = b;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }
  append(o: WriteBuffer) {
    this.bytes(o.unwrap());
  }
  clear() {
    this.length = 0;
  }
  unwrap(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

class ReadBuffer {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}
  get remaining() {
    return this.buf.length - this.pos;
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("parse ends prematurely");
    return this.buf[this.pos++];
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error("parse ends prematurely");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export function encodeVarInt(n: number, out: WriteBuffer = new WriteBuffer()): WriteBuffer {
  if (n === 0) {
    out.byte(0);
    return out;
  }
  const digits: number[] = [];
  while (n > 0) {
    digits.push(n % 128);
    n = Math.floor(n / 128);
  }
  for (let i = digits.length - 1; i >= 0; i--) out.byte(i === 0 ? digits[i] : digits[i] | 0x80);
  return out;
}

export function decodeVarInt(buf: ReadBuffer): number {
  let res = 0;
  for (let i = 0; ; i++) {
    if (i > 8) throw new Error("varint too long");
    const b = buf.byte();
    res = res * 128 + (b & 127);
    if ((b & 128) === 0) return res;
  }
}

// ------------------------------------------------------------------ fingerprint accumulator

const TWO_256 = 1n << 256n;

function bytesToBigLE(b: Uint8Array): bigint {
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
  return v;
}

function bigToBytesLE(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function fingerprintOf(ids: Iterable<Uint8Array>): Uint8Array {
  let sum = 0n;
  let n = 0;
  for (const id of ids) {
    sum = (sum + bytesToBigLE(id)) % TWO_256;
    n++;
  }
  return finalizeFingerprint(sum, n);
}

function finalizeFingerprint(sum: bigint, n: number): Uint8Array {
  return finalizeFingerprintBytes(bigToBytesLE(sum), n);
}

function finalizeFingerprintBytes(sumLE: Uint8Array, n: number): Uint8Array {
  const h = createHash("sha256");
  h.update(sumLE);
  h.update(encodeVarInt(n).unwrap());
  return new Uint8Array(h.digest()).subarray(0, FINGERPRINT_SIZE);
}

// ------------------------------------------------------------------ storage

const LIMBS = 8; // 256-bit sums as 8 little-endian uint32 limbs
const HEX_ID = /^[0-9a-f]{64}$/;

/**
 * Sorted vector storage with prefix sums for O(1) fingerprints. Items are kept in flat typed arrays
 * (8 bytes timestamp + 32 bytes id + 32 bytes prefix sum per item) rather than one object per item.
 */
export class NegentropyStorage {
  private pending: { timestamp: number; id: string }[] | null = [];
  private n = 0;
  private timestamps = new Float64Array(0);
  private ids = new Uint8Array(0);
  /** prefix[i] = sum of ids[0..i) mod 2^256, LIMBS uint32 per entry (n + 1 entries) */
  private prefix = new Uint32Array(LIMBS);

  insert(timestamp: number, idHex: string): void {
    if (!this.pending) throw new Error("already sealed");
    const id = idHex.toLowerCase();
    if (!HEX_ID.test(id)) throw new Error("bad id size");
    this.pending.push({ timestamp, id });
  }

  seal(): void {
    const items = this.pending;
    if (!items) throw new Error("already sealed");
    this.pending = null;
    // lowercase hex compares like the raw bytes
    items.sort((a, b) => (a.timestamp !== b.timestamp ? (a.timestamp < b.timestamp ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const n = items.length;
    this.n = n;
    this.timestamps = new Float64Array(n);
    this.ids = new Uint8Array(n * ID_SIZE);
    this.prefix = new Uint32Array((n + 1) * LIMBS);
    for (let i = 0; i < n; i++) {
      if (i > 0 && items[i - 1].timestamp === items[i].timestamp && items[i - 1].id === items[i].id) throw new Error("duplicate item inserted");
      this.timestamps[i] = items[i].timestamp;
      this.ids.set(hexToBytes(items[i].id), i * ID_SIZE);
      // prefix[i + 1] = prefix[i] + id (mod 2^256), limb by limb with carry
      const view = new DataView(this.ids.buffer, i * ID_SIZE, ID_SIZE);
      let carry = 0;
      for (let l = 0; l < LIMBS; l++) {
        const v = this.prefix[i * LIMBS + l] + view.getUint32(l * 4, true) + carry;
        this.prefix[(i + 1) * LIMBS + l] = v >>> 0;
        carry = v > 0xffffffff ? 1 : 0;
      }
    }
  }

  size(): number {
    this.check();
    return this.n;
  }

  getItem(i: number): Item {
    this.check();
    if (i >= this.n) throw new Error("out of range");
    return { timestamp: this.timestamps[i], id: this.ids.subarray(i * ID_SIZE, (i + 1) * ID_SIZE) };
  }

  iterate(begin: number, end: number, cb: (item: Item, index: number) => boolean | void): void {
    this.check();
    this.checkBounds(begin, end);
    for (let i = begin; i < end; i++) if (cb(this.getItem(i), i) === false) break;
  }

  findLowerBound(begin: number, end: number, bound: Item): number {
    this.check();
    let lo = begin;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareAt(mid, bound) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  fingerprint(begin: number, end: number): Uint8Array {
    this.check();
    this.checkBounds(begin, end);
    // (prefix[end] - prefix[begin]) mod 2^256, little-endian bytes
    const out = new Uint8Array(32);
    const view = new DataView(out.buffer);
    let borrow = 0;
    for (let l = 0; l < LIMBS; l++) {
      let v = this.prefix[end * LIMBS + l] - this.prefix[begin * LIMBS + l] - borrow;
      borrow = v < 0 ? 1 : 0;
      if (v < 0) v += 0x100000000;
      view.setUint32(l * 4, v, true);
    }
    return finalizeFingerprintBytes(out, end - begin);
  }

  private compareAt(i: number, b: Item): number {
    const t = this.timestamps[i];
    if (t !== b.timestamp) return t < b.timestamp ? -1 : 1;
    return compareBytes(this.ids.subarray(i * ID_SIZE, (i + 1) * ID_SIZE), b.id);
  }

  private check() {
    if (this.pending) throw new Error("not sealed");
  }
  private checkBounds(begin: number, end: number) {
    if (begin > end || end > this.n) throw new Error("bad range");
  }
}

// ------------------------------------------------------------------ protocol

export interface ReconcileResult {
  /** next message to send (hex), or null when reconciliation is complete (initiator only) */
  output: string | null;
  /** ids we have that the other side lacks (initiator only) */
  have: string[];
  /** ids the other side has that we lack (initiator only) */
  need: string[];
}

export class Negentropy {
  private isInitiator = false;
  private lastTimestampIn = 0;
  private lastTimestampOut = 0;
  private readonly frameSizeLimit: number;

  constructor(private readonly storage: NegentropyStorage, frameSizeLimit = 0) {
    if (frameSizeLimit !== 0 && frameSizeLimit < 4096) throw new Error("frameSizeLimit too small");
    this.frameSizeLimit = frameSizeLimit;
  }

  private bound(timestamp: number, id?: Uint8Array): Item {
    return { timestamp, id: id ?? new Uint8Array(0) };
  }

  /** Client side: builds the initial message (hex). */
  initiate(): string {
    if (this.isInitiator) throw new Error("already initiated");
    this.isInitiator = true;
    this.lastTimestampOut = 0;
    const out = new WriteBuffer();
    out.byte(PROTOCOL_VERSION);
    this.splitRange(0, this.storage.size(), this.bound(MAX_TIMESTAMP), out);
    return bytesToHex(out.unwrap());
  }

  /** Processes an incoming message (hex). */
  reconcile(queryHex: string): ReconcileResult {
    const have: string[] = [];
    const need: string[] = [];
    const out = this.reconcileAux(new ReadBuffer(hexToBytes(queryHex)), have, need);
    return { output: out === null ? null : bytesToHex(out), have, need };
  }

  private reconcileAux(query: ReadBuffer, have: string[], need: string[]): Uint8Array | null {
    this.lastTimestampIn = this.lastTimestampOut = 0;
    const fullOutput = new WriteBuffer();
    fullOutput.byte(PROTOCOL_VERSION);

    const protocolVersion = query.byte();
    if (protocolVersion < 0x60 || protocolVersion > 0x6f) throw new Error("invalid negentropy protocol version byte");
    if (protocolVersion !== PROTOCOL_VERSION) {
      if (this.isInitiator) throw new Error(`unsupported negentropy protocol version requested: ${protocolVersion - 0x60}`);
      return fullOutput.unwrap();
    }

    const storageSize = this.storage.size();
    let prevBound = this.bound(0);
    let prevIndex = 0;
    let skip = false;

    while (query.remaining !== 0) {
      const o = new WriteBuffer();
      const doSkip = () => {
        if (!skip) return;
        skip = false;
        this.encodeBound(prevBound, o);
        encodeVarInt(Mode.Skip, o);
      };

      const currBound = this.decodeBound(query);
      const mode = decodeVarInt(query);
      const lower = prevIndex;
      let upper = this.storage.findLowerBound(prevIndex, storageSize, currBound);

      if (mode === Mode.Skip) {
        skip = true;
      } else if (mode === Mode.Fingerprint) {
        const theirs = query.bytes(FINGERPRINT_SIZE);
        const ours = this.storage.fingerprint(lower, upper);
        if (compareBytes(theirs, ours) !== 0) {
          doSkip();
          this.splitRange(lower, upper, currBound, o);
        } else {
          skip = true;
        }
      } else if (mode === Mode.IdList) {
        const numIds = decodeVarInt(query);
        const theirElems = new Set<string>();
        for (let i = 0; i < numIds; i++) {
          const e = query.bytes(ID_SIZE);
          if (this.isInitiator) theirElems.add(bytesToHex(e));
        }
        if (this.isInitiator) {
          skip = true;
          this.storage.iterate(lower, upper, (item) => {
            const k = bytesToHex(item.id);
            if (!theirElems.has(k)) have.push(k);
            else theirElems.delete(k);
          });
          for (const k of theirElems) need.push(k);
        } else {
          doSkip();
          const responseIds = new WriteBuffer();
          let numResponseIds = 0;
          let endBound = currBound;
          this.storage.iterate(lower, upper, (item, index) => {
            if (this.exceededFrameSizeLimit(fullOutput.length + responseIds.length)) {
              endBound = item;
              upper = index; // shrink upper so the next range starts here
              return false;
            }
            responseIds.bytes(item.id);
            numResponseIds++;
            return true;
          });
          this.encodeBound(endBound, o);
          encodeVarInt(Mode.IdList, o);
          encodeVarInt(numResponseIds, o);
          o.append(responseIds);
          fullOutput.append(o);
          o.clear();
        }
      } else {
        throw new Error("unexpected mode");
      }

      if (this.exceededFrameSizeLimit(fullOutput.length + o.length)) {
        // frame size limit exceeded: stop and return a fingerprint for the remaining range
        const remaining = this.storage.fingerprint(upper, storageSize);
        this.encodeBound(this.bound(MAX_TIMESTAMP), fullOutput);
        encodeVarInt(Mode.Fingerprint, fullOutput);
        fullOutput.bytes(remaining);
        break;
      } else {
        fullOutput.append(o);
      }

      prevIndex = upper;
      prevBound = currBound;
    }

    return fullOutput.length === 1 && this.isInitiator ? null : fullOutput.unwrap();
  }

  private splitRange(lower: number, upper: number, upperBound: Item, o: WriteBuffer) {
    const numElems = upper - lower;
    if (numElems < DOUBLE_BUCKETS) {
      this.encodeBound(upperBound, o);
      encodeVarInt(Mode.IdList, o);
      encodeVarInt(numElems, o);
      this.storage.iterate(lower, upper, (item) => {
        o.bytes(item.id);
      });
      return;
    }
    const itemsPerBucket = Math.floor(numElems / BUCKETS);
    const bucketsWithExtra = numElems % BUCKETS;
    let curr = lower;
    for (let i = 0; i < BUCKETS; i++) {
      const bucketSize = itemsPerBucket + (i < bucketsWithExtra ? 1 : 0);
      const ours = this.storage.fingerprint(curr, curr + bucketSize);
      curr += bucketSize;
      let nextBound: Item;
      if (curr === upper) nextBound = upperBound;
      else nextBound = this.getMinimalBound(this.storage.getItem(curr - 1), this.storage.getItem(curr));
      this.encodeBound(nextBound, o);
      encodeVarInt(Mode.Fingerprint, o);
      o.bytes(ours);
    }
  }

  private exceededFrameSizeLimit(n: number): boolean {
    return this.frameSizeLimit !== 0 && n > this.frameSizeLimit - 200;
  }

  // -------- bounds / timestamps

  private decodeTimestampIn(buf: ReadBuffer): number {
    let timestamp = decodeVarInt(buf);
    timestamp = timestamp === 0 ? MAX_TIMESTAMP : timestamp - 1;
    if (this.lastTimestampIn === MAX_TIMESTAMP || timestamp === MAX_TIMESTAMP) {
      this.lastTimestampIn = MAX_TIMESTAMP;
      return MAX_TIMESTAMP;
    }
    timestamp += this.lastTimestampIn;
    this.lastTimestampIn = timestamp;
    return timestamp;
  }

  private decodeBound(buf: ReadBuffer): Item {
    const timestamp = this.decodeTimestampIn(buf);
    const len = decodeVarInt(buf);
    if (len > ID_SIZE) throw new Error("bound key too long");
    return this.bound(timestamp, buf.bytes(len));
  }

  private encodeTimestampOut(timestamp: number, o: WriteBuffer) {
    if (timestamp === MAX_TIMESTAMP) {
      this.lastTimestampOut = MAX_TIMESTAMP;
      encodeVarInt(0, o);
      return;
    }
    const temp = timestamp;
    timestamp -= this.lastTimestampOut;
    this.lastTimestampOut = temp;
    encodeVarInt(timestamp + 1, o);
  }

  private encodeBound(b: Item, o: WriteBuffer) {
    this.encodeTimestampOut(b.timestamp, o);
    encodeVarInt(b.id.length, o);
    o.bytes(b.id);
  }

  private getMinimalBound(prev: Item, curr: Item): Item {
    if (curr.timestamp !== prev.timestamp) return this.bound(curr.timestamp);
    let shared = 0;
    for (let i = 0; i < ID_SIZE; i++) {
      if (curr.id[i] !== prev.id[i]) break;
      shared++;
    }
    return this.bound(curr.timestamp, curr.id.subarray(0, shared + 1));
  }
}
