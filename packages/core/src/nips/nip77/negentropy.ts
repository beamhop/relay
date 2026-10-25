/**
 * Negentropy protocol v1 (NIP-77), written after the reference implementation by Doug Hoyte
 * (https://github.com/hoytech/negentropy, MIT). Supports both initiator (client) and responder (relay) roles.
 */
import { createHash } from "node:crypto";
import { bytesToHex, hexToBytes } from "../../util/hex";

const PROTOCOL_VERSION = 0x61;
const ID_SIZE = 32;
const FINGERPRINT_SIZE = 16;
const BUCKETS = 16;
const DOUBLE_BUCKETS = BUCKETS * 2;
/** Timestamp used for the "infinity" bound */
const MAX_TIMESTAMP = Number.MAX_SAFE_INTEGER;

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

function sameId(ids: Uint8Array, a: number, b: number): boolean {
  for (let i = 0; i < ID_SIZE; i++) if (ids[a + i] !== ids[b + i]) return false;
  return true;
}

/** Whether the first `n` (timestamp, id) items are in non-decreasing order (O(n), no allocation). */
function inOrder(ts: Float64Array, ids: Uint8Array, n: number): boolean {
  for (let k = 1; k < n; k++) {
    if (ts[k] !== ts[k - 1]) {
      if (ts[k] < ts[k - 1]) return false;
      continue;
    }
    const a = (k - 1) * ID_SIZE;
    const b = k * ID_SIZE;
    for (let i = 0; i < ID_SIZE; i++) {
      if (ids[a + i] !== ids[b + i]) {
        if (ids[a + i] > ids[b + i]) return false;
        break;
      }
    }
  }
  return true;
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

function encodeVarInt(n: number, out: WriteBuffer = new WriteBuffer()): WriteBuffer {
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

function decodeVarInt(buf: ReadBuffer): number {
  let res = 0;
  for (let i = 0; ; i++) {
    if (i > 8) throw new Error("varint too long");
    const b = buf.byte();
    res = res * 128 + (b & 127);
    if ((b & 128) === 0) return res;
  }
}

// ------------------------------------------------------------------ fingerprints

/** NIP-77 fingerprint: sha256 of the 256-bit little-endian id sum and the varint item count, truncated. */
function finalizeFingerprintBytes(sumLE: Uint8Array, n: number): Uint8Array {
  const h = createHash("sha256");
  h.update(sumLE);
  h.update(encodeVarInt(n).unwrap());
  return new Uint8Array(h.digest()).subarray(0, FINGERPRINT_SIZE);
}

// ------------------------------------------------------------------ storage

const LIMBS = 8; // 256-bit sums as 8 little-endian uint32 limbs

/** Value of one hex digit (either case), or -1. */
function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return -1;
}

/**
 * Sorted vector storage with prefix sums for O(1) fingerprints. Items are written straight into flat typed arrays
 * (8 bytes timestamp + 32 bytes id per item while inserting, plus a 32-byte prefix sum once sealed) rather than one
 * object per item, so a session over hundreds of thousands of ids stays compact while it is built, too.
 */
export class NegentropyStorage {
  private sealed = false;
  private n = 0;
  private timestamps = new Float64Array(256);
  private ids = new Uint8Array(256 * ID_SIZE);
  /** prefix[i] = sum of ids[0..i) mod 2^256, LIMBS uint32 per entry (n + 1 entries) */
  private prefix = new Uint32Array(LIMBS);

  /** Items inserted so far (duplicates are only merged by seal()). */
  get inserted(): number {
    return this.n;
  }

  /** Item slots allocated before seal() (what the storage holds in memory while items are inserted). */
  get capacity(): number {
    return this.timestamps.length;
  }

  /** Makes room for `extra` more items, exactly (rather than doubling), e.g. before inserting a page of known size. */
  reserve(extra: number): void {
    if (this.sealed) throw new Error("already sealed");
    if (this.n + extra > this.timestamps.length) this.resize(this.n + extra);
  }

  insert(timestamp: number, idHex: string): void {
    if (this.sealed) throw new Error("already sealed");
    if (idHex.length !== ID_SIZE * 2) throw new Error("bad id size");
    if (this.n === this.timestamps.length) this.grow();
    const off = this.n * ID_SIZE;
    for (let i = 0; i < ID_SIZE; i++) {
      const hi = hexDigit(idHex.charCodeAt(2 * i));
      const lo = hexDigit(idHex.charCodeAt(2 * i + 1));
      if (hi < 0 || lo < 0) throw new Error("bad id size");
      this.ids[off + i] = (hi << 4) | lo;
    }
    this.timestamps[this.n++] = timestamp;
  }

  /** The inserted items in insertion order (before seal()). */
  pendingItems(): { id: string; created_at: number }[] {
    if (this.sealed) throw new Error("already sealed");
    const out: { id: string; created_at: number }[] = [];
    for (let i = 0; i < this.n; i++) out.push({ id: bytesToHex(this.ids.subarray(i * ID_SIZE, (i + 1) * ID_SIZE)), created_at: this.timestamps[i] });
    return out;
  }

  /** Sorts the items, merges duplicates and leaves out `exclude` (items that may not be disclosed), then builds the prefix sums. */
  seal(exclude: Iterable<{ id: string; created_at: number }> = []): void {
    if (this.sealed) throw new Error("already sealed");
    this.sealed = true;
    const n = this.n;
    const ts = this.timestamps;
    const ids = this.ids;
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    // one filter's ids are listed in (timestamp, id) order already: then the sort is skipped
    const sorted = inOrder(ts, ids, n);
    if (!sorted) {
      // sort an index by (timestamp, id bytes); the first 4 id bytes settle almost every tie
      const head = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const o = i * ID_SIZE;
        head[i] = ((ids[o] << 24) | (ids[o + 1] << 16) | (ids[o + 2] << 8) | ids[o + 3]) >>> 0;
      }
      order.sort((a, b) => ts[a] - ts[b] || head[a] - head[b] || compareBytes(ids.subarray(a * ID_SIZE + 4, (a + 1) * ID_SIZE), ids.subarray(b * ID_SIZE + 4, (b + 1) * ID_SIZE)));
    }
    const at = (k: number) => ids.subarray(order[k] * ID_SIZE, (order[k] + 1) * ID_SIZE);
    const keep = new Uint8Array(n).fill(1);
    for (let k = 1; k < n; k++) if (ts[order[k]] === ts[order[k - 1]] && sameId(ids, order[k] * ID_SIZE, order[k - 1] * ID_SIZE)) keep[k] = 0;
    for (const it of exclude) {
      const id = new Uint8Array(ID_SIZE);
      if (it.id.length !== ID_SIZE * 2) continue;
      for (let i = 0; i < ID_SIZE; i++) id[i] = (hexDigit(it.id.charCodeAt(2 * i)) << 4) | hexDigit(it.id.charCodeAt(2 * i + 1));
      let lo = 0;
      let hi = n;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const c = ts[order[mid]] !== it.created_at ? (ts[order[mid]] < it.created_at ? -1 : 1) : compareBytes(at(mid), id);
        if (c < 0) lo = mid + 1;
        else hi = mid;
      }
      // duplicates sit next to each other
      for (let k = lo; k < n && ts[order[k]] === it.created_at && compareBytes(at(k), id) === 0; k++) keep[k] = 0;
    }
    let count = 0;
    for (let k = 0; k < n; k++) count += keep[k];
    // in order with nothing left out: the inserted arrays are kept (trimmed to size) instead of copied
    const same = sorted && count === n;
    const exact = ts.length === n;
    const outTs = same ? (exact ? ts : ts.slice(0, n)) : new Float64Array(count);
    const outIds = same ? (exact ? ids : ids.slice(0, n * ID_SIZE)) : new Uint8Array(count * ID_SIZE);
    const prefix = new Uint32Array((count + 1) * LIMBS);
    const view = new DataView(outIds.buffer, outIds.byteOffset, outIds.byteLength);
    let j = 0;
    for (let k = 0; k < n; k++) {
      if (!keep[k]) continue;
      if (!same) {
        outTs[j] = ts[order[k]];
        outIds.set(at(k), j * ID_SIZE);
      }
      // prefix[j + 1] = prefix[j] + id (mod 2^256), limb by limb with carry
      let carry = 0;
      for (let l = 0; l < LIMBS; l++) {
        const v = prefix[j * LIMBS + l] + view.getUint32(j * ID_SIZE + l * 4, true) + carry;
        prefix[(j + 1) * LIMBS + l] = v >>> 0;
        carry = v > 0xffffffff ? 1 : 0;
      }
      j++;
    }
    this.n = count;
    this.timestamps = outTs;
    this.ids = outIds;
    this.prefix = prefix;
  }

  private grow() {
    this.resize(this.timestamps.length * 2);
  }

  private resize(cap: number) {
    const ts = new Float64Array(cap);
    ts.set(this.timestamps.subarray(0, this.n));
    const ids = new Uint8Array(cap * ID_SIZE);
    ids.set(this.ids.subarray(0, this.n * ID_SIZE));
    this.timestamps = ts;
    this.ids = ids;
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
    if (!this.sealed) throw new Error("not sealed");
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
