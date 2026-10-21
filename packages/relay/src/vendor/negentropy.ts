// SPDX-License-Identifier: MIT
// (C) 2023 Doug Hoyte. MIT license — see ./LICENSE-negentropy.
//
// Vendored from https://github.com/hoytech/negentropy (js/Negentropy.js, protocol V1).
// Local modifications (behavior-preserving except where noted):
// - Ported to TypeScript + ESM exports.
// - SHA-256 uses WebCrypto (`crypto.subtle`) only, so it runs on Bun and Workers
//   (upstream used `require('crypto')` under Node).
// - Fix: `loadInputBuffer` compared a bare `__proto__` instead of `inp.__proto__`.
// - Fix: DataViews honor `byteOffset`, and `negate()` writes little-endian
//   (upstream wrote big-endian; `negate()` is unused by reconciliation).
// - IdList membership uses hex keys instead of stringified Uint8Arrays.

const PROTOCOL_VERSION = 0x61; // Version 1
const ID_SIZE = 32;
const FINGERPRINT_SIZE = 16;

const Mode = {
  Skip: 0,
  Fingerprint: 1,
  IdList: 2,
} as const;

export interface NegentropyItem {
  timestamp: number;
  id: Uint8Array;
}

type BufLike = WrappedBuffer | Uint8Array | number[];

class WrappedBuffer {
  _raw: Uint8Array;
  length: number;

  constructor(buffer?: Uint8Array | number[]) {
    this._raw = buffer ? new Uint8Array(buffer) : new Uint8Array(512);
    this.length = buffer ? buffer.length : 0;
  }

  unwrap(): Uint8Array {
    return this._raw.subarray(0, this.length);
  }

  get capacity(): number {
    return this._raw.byteLength;
  }

  extend(input: BufLike): void {
    const buf = input instanceof WrappedBuffer ? input.unwrap() : input;
    if (typeof buf.length !== 'number') throw Error('bad length');
    const targetSize = buf.length + this.length;
    if (this.capacity < targetSize) {
      const oldRaw = this._raw;
      const newCapacity = Math.max(this.capacity * 2, targetSize);
      this._raw = new Uint8Array(newCapacity);
      this._raw.set(oldRaw);
    }

    this._raw.set(buf, this.length);
    this.length += buf.length;
  }

  shift(): number {
    const first = this._raw[0]!;
    this._raw = this._raw.subarray(1);
    this.length--;
    return first;
  }

  shiftN(n = 1): Uint8Array {
    const firstSubarray = this._raw.subarray(0, n);
    this._raw = this._raw.subarray(n);
    this.length -= n;
    return firstSubarray;
  }
}

function decodeVarInt(buf: WrappedBuffer): number {
  let res = 0;

  for (;;) {
    if (buf.length === 0) throw Error('parse ends prematurely');
    const byte = buf.shift();
    res = (res << 7) | (byte & 127);
    if ((byte & 128) === 0) break;
  }

  return res;
}

function encodeVarInt(n: number): WrappedBuffer {
  if (n === 0) return new WrappedBuffer([0]);

  const o: number[] = [];
  let v = n;

  while (v !== 0) {
    o.push(v & 127);
    v >>>= 7;
  }

  o.reverse();

  for (let i = 0; i < o.length - 1; i++) o[i] = o[i]! | 128;

  return new WrappedBuffer(o);
}

function getByte(buf: WrappedBuffer): number {
  return getBytes(buf, 1)[0]!;
}

function getBytes(buf: WrappedBuffer, n: number): Uint8Array {
  if (buf.length < n) throw Error('parse ends prematurely');
  return buf.shiftN(n);
}

class Accumulator {
  buf: Uint8Array = new Uint8Array(ID_SIZE);

  constructor() {
    this.setToZero();
  }

  async sha256(slice: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', slice as Uint8Array<ArrayBuffer>));
  }

  setToZero(): void {
    this.buf = new Uint8Array(ID_SIZE);
  }

  add(otherBuf: Uint8Array): void {
    let currCarry = 0;
    let nextCarry = 0;
    const p = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const po = new DataView(otherBuf.buffer, otherBuf.byteOffset, otherBuf.byteLength);

    for (let i = 0; i < 8; i++) {
      const offset = i * 4;
      const orig = p.getUint32(offset, true);
      const otherV = po.getUint32(offset, true);

      let next = orig;

      next += currCarry;
      next += otherV;
      if (next > 0xffffffff) nextCarry = 1;

      p.setUint32(offset, next >>> 0, true);
      currCarry = nextCarry;
      nextCarry = 0;
    }
  }

  negate(): void {
    const p = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);

    for (let i = 0; i < 8; i++) {
      const offset = i * 4;
      p.setUint32(offset, ~p.getUint32(offset, true) >>> 0, true);
    }

    const one = new Uint8Array(ID_SIZE);
    one[0] = 1;
    this.add(one);
  }

  async getFingerprint(n: number): Promise<Uint8Array> {
    const input = new WrappedBuffer();
    input.extend(this.buf);
    input.extend(encodeVarInt(n));

    const hash = await this.sha256(input.unwrap());

    return hash.subarray(0, FINGERPRINT_SIZE);
  }
}

export class NegentropyStorageVector {
  items: NegentropyItem[] = [];
  sealed = false;

  insert(timestamp: number, id: string | Uint8Array): void {
    if (this.sealed) throw Error('already sealed');
    const buf = loadInputBuffer(id);
    if (buf.byteLength !== ID_SIZE) throw Error('bad id size for added item');
    this.items.push({ timestamp, id: buf });
  }

  seal(): void {
    if (this.sealed) throw Error('already sealed');
    this.sealed = true;

    this.items.sort(itemCompare);

    for (let i = 1; i < this.items.length; i++) {
      if (itemCompare(this.items[i - 1]!, this.items[i]!) === 0)
        throw Error('duplicate item inserted');
    }
  }

  unseal(): void {
    this.sealed = false;
  }

  size(): number {
    this._checkSealed();
    return this.items.length;
  }

  getItem(i: number): NegentropyItem {
    this._checkSealed();
    if (i >= this.items.length) throw Error('out of range');
    return this.items[i]!;
  }

  iterate(begin: number, end: number, cb: (item: NegentropyItem, i: number) => boolean): void {
    this._checkSealed();
    this._checkBounds(begin, end);

    for (let i = begin; i < end; ++i) {
      if (!cb(this.items[i]!, i)) break;
    }
  }

  findLowerBound(begin: number, end: number, bound: NegentropyItem): number {
    this._checkSealed();
    this._checkBounds(begin, end);

    return this._binarySearch(this.items, begin, end, (a) => itemCompare(a, bound) < 0);
  }

  async fingerprint(begin: number, end: number): Promise<Uint8Array> {
    const out = new Accumulator();
    out.setToZero();

    this.iterate(begin, end, (item) => {
      out.add(item.id);
      return true;
    });

    return await out.getFingerprint(end - begin);
  }

  _checkSealed(): void {
    if (!this.sealed) throw Error('not sealed');
  }

  _checkBounds(begin: number, end: number): void {
    if (begin > end || end > this.items.length) throw Error('bad range');
  }

  _binarySearch(
    arr: NegentropyItem[],
    firstIn: number,
    last: number,
    cmp: (a: NegentropyItem) => boolean,
  ): number {
    let first = firstIn;
    let count = last - first;

    while (count > 0) {
      let it = first;
      const step = Math.floor(count / 2);
      it += step;

      if (cmp(arr[it]!)) {
        first = ++it;
        count -= step + 1;
      } else {
        count = step;
      }
    }

    return first;
  }
}

export class Negentropy {
  storage: NegentropyStorageVector;
  frameSizeLimit: number;
  lastTimestampIn = 0;
  lastTimestampOut = 0;
  isInitiator = false;
  wantUint8ArrayOutput = false;

  constructor(storage: NegentropyStorageVector, frameSizeLimit = 0) {
    if (frameSizeLimit !== 0 && frameSizeLimit < 4096) throw Error('frameSizeLimit too small');

    this.storage = storage;
    this.frameSizeLimit = frameSizeLimit;
  }

  _bound(timestamp: number, id?: Uint8Array): NegentropyItem {
    return { timestamp, id: id ? id : new Uint8Array(0) };
  }

  async initiate(): Promise<string> {
    if (this.isInitiator) throw Error('already initiated');
    this.isInitiator = true;

    const output = new WrappedBuffer();
    output.extend([PROTOCOL_VERSION]);

    await this.splitRange(0, this.storage.size(), this._bound(Number.MAX_VALUE), output);

    return this._renderOutput(output);
  }

  setInitiator(): void {
    this.isInitiator = true;
  }

  async reconcile(queryIn: string | Uint8Array): Promise<[string | null, string[], string[]]> {
    const haveIds: string[] = [];
    const needIds: string[] = [];
    const query = new WrappedBuffer(loadInputBuffer(queryIn));

    this.lastTimestampIn = this.lastTimestampOut = 0; // reset for each message

    const fullOutput = new WrappedBuffer();
    fullOutput.extend([PROTOCOL_VERSION]);

    const protocolVersion = getByte(query);
    if (protocolVersion < 0x60 || protocolVersion > 0x6f)
      throw Error('invalid negentropy protocol version byte');
    if (protocolVersion !== PROTOCOL_VERSION) {
      if (this.isInitiator)
        throw Error(`unsupported negentropy protocol version requested: ${protocolVersion - 0x60}`);
      return [this._renderOutput(fullOutput), haveIds, needIds];
    }

    const storageSize = this.storage.size();
    let prevBound = this._bound(0);
    let prevIndex = 0;
    let skip = false;

    while (query.length !== 0) {
      let o = new WrappedBuffer();

      const doSkip = () => {
        if (skip) {
          skip = false;
          o.extend(this.encodeBound(prevBound));
          o.extend(encodeVarInt(Mode.Skip));
        }
      };

      const currBound = this.decodeBound(query);
      const mode = decodeVarInt(query);

      const lower = prevIndex;
      let upper = this.storage.findLowerBound(prevIndex, storageSize, currBound);

      if (mode === Mode.Skip) {
        skip = true;
      } else if (mode === Mode.Fingerprint) {
        const theirFingerprint = getBytes(query, FINGERPRINT_SIZE);
        const ourFingerprint = await this.storage.fingerprint(lower, upper);

        if (compareUint8Array(theirFingerprint, ourFingerprint) !== 0) {
          doSkip();
          await this.splitRange(lower, upper, currBound, o);
        } else {
          skip = true;
        }
      } else if (mode === Mode.IdList) {
        const numIds = decodeVarInt(query);

        const theirElems = new Map<string, Uint8Array>();
        for (let i = 0; i < numIds; i++) {
          const e = getBytes(query, ID_SIZE);
          if (this.isInitiator) theirElems.set(uint8ArrayToHex(e), e);
        }

        if (this.isInitiator) {
          skip = true;

          this.storage.iterate(lower, upper, (item) => {
            const k = uint8ArrayToHex(item.id);

            if (!theirElems.has(k)) {
              // ID exists on our side, but not their side
              haveIds.push(k);
            } else {
              // ID exists on both sides
              theirElems.delete(k);
            }

            return true;
          });

          for (const k of theirElems.keys()) {
            // ID exists on their side, but not our side
            needIds.push(k);
          }
        } else {
          doSkip();

          const responseIds = new WrappedBuffer();
          let numResponseIds = 0;
          let endBound = currBound;

          this.storage.iterate(lower, upper, (item, index) => {
            if (this.exceededFrameSizeLimit(fullOutput.length + responseIds.length)) {
              endBound = item;
              upper = index; // shrink upper so that remaining range gets correct fingerprint
              return false;
            }

            responseIds.extend(item.id);
            numResponseIds++;
            return true;
          });

          o.extend(this.encodeBound(endBound));
          o.extend(encodeVarInt(Mode.IdList));
          o.extend(encodeVarInt(numResponseIds));
          o.extend(responseIds);

          fullOutput.extend(o);
          o = new WrappedBuffer();
        }
      } else {
        throw Error('unexpected mode');
      }

      if (this.exceededFrameSizeLimit(fullOutput.length + o.length)) {
        // frameSizeLimit exceeded: Stop range processing and return a fingerprint for the remaining range
        const remainingFingerprint = await this.storage.fingerprint(upper, storageSize);

        fullOutput.extend(this.encodeBound(this._bound(Number.MAX_VALUE)));
        fullOutput.extend(encodeVarInt(Mode.Fingerprint));
        fullOutput.extend(remainingFingerprint);
        break;
      }
      fullOutput.extend(o);

      prevIndex = upper;
      prevBound = currBound;
    }

    return [
      fullOutput.length === 1 && this.isInitiator ? null : this._renderOutput(fullOutput),
      haveIds,
      needIds,
    ];
  }

  async splitRange(
    lower: number,
    upper: number,
    upperBound: NegentropyItem,
    o: WrappedBuffer,
  ): Promise<void> {
    const numElems = upper - lower;
    const buckets = 16;

    if (numElems < buckets * 2) {
      o.extend(this.encodeBound(upperBound));
      o.extend(encodeVarInt(Mode.IdList));

      o.extend(encodeVarInt(numElems));
      this.storage.iterate(lower, upper, (item) => {
        o.extend(item.id);
        return true;
      });
    } else {
      const itemsPerBucket = Math.floor(numElems / buckets);
      const bucketsWithExtra = numElems % buckets;
      let curr = lower;

      for (let i = 0; i < buckets; i++) {
        const bucketSize = itemsPerBucket + (i < bucketsWithExtra ? 1 : 0);
        const ourFingerprint = await this.storage.fingerprint(curr, curr + bucketSize);
        curr += bucketSize;

        let nextBound: NegentropyItem;

        if (curr === upper) {
          nextBound = upperBound;
        } else {
          let prevItem: NegentropyItem | undefined;
          let currItem: NegentropyItem | undefined;

          this.storage.iterate(curr - 1, curr + 1, (item, index) => {
            if (index === curr - 1) prevItem = item;
            else currItem = item;
            return true;
          });

          nextBound = this.getMinimalBound(prevItem!, currItem!);
        }

        o.extend(this.encodeBound(nextBound));
        o.extend(encodeVarInt(Mode.Fingerprint));
        o.extend(ourFingerprint);
      }
    }
  }

  _renderOutput(o: WrappedBuffer): string {
    return uint8ArrayToHex(o.unwrap());
  }

  exceededFrameSizeLimit(n: number): boolean {
    return this.frameSizeLimit !== 0 && n > this.frameSizeLimit - 200;
  }

  // Decoding

  decodeTimestampIn(encoded: WrappedBuffer): number {
    let timestamp = decodeVarInt(encoded);
    timestamp = timestamp === 0 ? Number.MAX_VALUE : timestamp - 1;
    if (this.lastTimestampIn === Number.MAX_VALUE || timestamp === Number.MAX_VALUE) {
      this.lastTimestampIn = Number.MAX_VALUE;
      return Number.MAX_VALUE;
    }
    timestamp += this.lastTimestampIn;
    this.lastTimestampIn = timestamp;
    return timestamp;
  }

  decodeBound(encoded: WrappedBuffer): NegentropyItem {
    const timestamp = this.decodeTimestampIn(encoded);
    const len = decodeVarInt(encoded);
    if (len > ID_SIZE) throw Error('bound key too long');
    const id = getBytes(encoded, len);
    return { timestamp, id };
  }

  // Encoding

  encodeTimestampOut(timestampIn: number): WrappedBuffer {
    if (timestampIn === Number.MAX_VALUE) {
      this.lastTimestampOut = Number.MAX_VALUE;
      return encodeVarInt(0);
    }

    const temp = timestampIn;
    const timestamp = timestampIn - this.lastTimestampOut;
    this.lastTimestampOut = temp;
    return encodeVarInt(timestamp + 1);
  }

  encodeBound(key: NegentropyItem): WrappedBuffer {
    const output = new WrappedBuffer();

    output.extend(this.encodeTimestampOut(key.timestamp));
    output.extend(encodeVarInt(key.id.length));
    output.extend(key.id);

    return output;
  }

  getMinimalBound(prev: NegentropyItem, curr: NegentropyItem): NegentropyItem {
    if (curr.timestamp !== prev.timestamp) {
      return this._bound(curr.timestamp);
    }
    let sharedPrefixBytes = 0;
    const currKey = curr.id;
    const prevKey = prev.id;

    for (let i = 0; i < ID_SIZE; i++) {
      if (currKey[i] !== prevKey[i]) break;
      sharedPrefixBytes++;
    }

    return this._bound(curr.timestamp, curr.id.subarray(0, sharedPrefixBytes + 1));
  }
}

function loadInputBuffer(inp: string | Uint8Array): Uint8Array {
  if (typeof inp === 'string') return hexToUint8Array(inp);
  if (Object.getPrototypeOf(inp) !== Uint8Array.prototype) return new Uint8Array(inp); // node Buffer?
  return inp;
}

function hexToUint8Array(hIn: string): Uint8Array {
  const h = hIn.startsWith('0x') ? hIn.substring(2) : hIn;
  if (h.length % 2 === 1) throw Error('odd length of hex string');
  if (!/^[0-9a-fA-F]*$/.test(h)) throw Error('invalid hex string');
  const arr = new Uint8Array(h.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = Number.parseInt(h.substring(i * 2, i * 2 + 2), 16);
  return arr;
}

const uint8ArrayToHexLookupTable: string[] = new Array(256);
{
  const hexAlphabet = '0123456789abcdef';
  for (let i = 0; i < 256; i++) {
    uint8ArrayToHexLookupTable[i] = hexAlphabet[(i >>> 4) & 0xf]! + hexAlphabet[i & 0xf]!;
  }
}

function uint8ArrayToHex(arr: Uint8Array): string {
  let out = '';
  for (let i = 0, edx = arr.length; i < edx; i++) {
    out += uint8ArrayToHexLookupTable[arr[i]!];
  }
  return out;
}

function compareUint8Array(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.byteLength; i++) {
    if (i >= b.byteLength) return 1;
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }

  if (a.byteLength > b.byteLength) return 1;
  if (a.byteLength < b.byteLength) return -1;

  return 0;
}

function itemCompare(a: NegentropyItem, b: NegentropyItem): number {
  if (a.timestamp === b.timestamp) {
    return compareUint8Array(a.id, b.id);
  }

  return a.timestamp - b.timestamp;
}
