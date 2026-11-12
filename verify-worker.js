// ../core/src/pipeline/verify-worker.ts
import { parentPort } from "node:worker_threads";

// ../core/src/pipeline/schnorr.ts
import { Buffer } from "node:buffer";

// ../../node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/utils.js
/*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) */
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n, title = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    let prefix = title && `"${title}" `;
    throw Error(`${prefix}expected integer >= 0, got ${n}`);
  }
}
function abytes(value, length, title = "") {
  let bytes = isBytes(value), len = value?.length, needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    let prefix = title && `"${title}" `, ofLen = needsLen ? ` of length ${length}` : "", got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = !0) {
  if (instance.destroyed)
    throw Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out, void 0, "digestInto() output");
  let min = instance.outputLen;
  if (out.length < min)
    throw Error('"digestInto() output" expected to be of length >=' + min);
}
function clean(...arrays) {
  for (let i = 0;i < arrays.length; i++)
    arrays[i].fill(0);
}
function createView(arr) {
  return new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
}
function rotr(word, shift) {
  return word << 32 - shift | word >>> shift;
}
var hasHexBuiltin = /* @__PURE__ */ (() => typeof Uint8Array.from([]).toHex === "function" && typeof Uint8Array.fromHex === "function")(), hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  if (abytes(bytes), hasHexBuiltin)
    return bytes.toHex();
  let hex = "";
  for (let i = 0;i < bytes.length; i++)
    hex += hexes[bytes[i]];
  return hex;
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw Error("hex string expected, got " + typeof hex);
  if (hasHexBuiltin)
    return Uint8Array.fromHex(hex);
  let hl = hex.length, al = hl / 2;
  if (hl % 2)
    throw Error("hex string expected, got unpadded hex of length " + hl);
  let array = new Uint8Array(al);
  for (let ai = 0, hi = 0;ai < al; ai++, hi += 2) {
    let n1 = asciiToBase16(hex.charCodeAt(hi)), n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      let char = hex[hi] + hex[hi + 1];
      throw Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0;i < arrays.length; i++) {
    let a = arrays[i];
    abytes(a), sum += a.length;
  }
  let res = new Uint8Array(sum);
  for (let i = 0, pad = 0;i < arrays.length; i++) {
    let a = arrays[i];
    res.set(a, pad), pad += a.length;
  }
  return res;
}
function createHasher(hashCons, info = {}) {
  let hashC = (msg, opts) => hashCons(opts).update(msg).digest(), tmp = hashCons(void 0);
  return hashC.outputLen = tmp.outputLen, hashC.blockLen = tmp.blockLen, hashC.create = (opts) => hashCons(opts), Object.assign(hashC, info), Object.freeze(hashC);
}
function randomBytes(bytesLength = 32) {
  let cr = typeof globalThis === "object" ? globalThis.crypto : null;
  if (typeof cr?.getRandomValues !== "function")
    throw Error("crypto.getRandomValues must be defined");
  return cr.getRandomValues(new Uint8Array(bytesLength));
}
var oidNist = (suffix) => ({
  oid: Uint8Array.from([6, 9, 96, 134, 72, 1, 101, 3, 4, 2, suffix])
});

// ../../node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/_md.js
function Chi(a, b, c) {
  return a & b ^ ~a & c;
}
function Maj(a, b, c) {
  return a & b ^ a & c ^ b & c;
}

class HashMD {
  blockLen;
  outputLen;
  padOffset;
  isLE;
  buffer;
  view;
  finished = !1;
  length = 0;
  pos = 0;
  destroyed = !1;
  constructor(blockLen, outputLen, padOffset, isLE) {
    this.blockLen = blockLen, this.outputLen = outputLen, this.padOffset = padOffset, this.isLE = isLE, this.buffer = new Uint8Array(blockLen), this.view = createView(this.buffer);
  }
  update(data) {
    aexists(this), abytes(data);
    let { view, buffer, blockLen } = this, len = data.length;
    for (let pos = 0;pos < len; ) {
      let take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        let dataView = createView(data);
        for (;blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      if (buffer.set(data.subarray(pos, pos + take), this.pos), this.pos += take, pos += take, this.pos === blockLen)
        this.process(view, 0), this.pos = 0;
    }
    return this.length += data.length, this.roundClean(), this;
  }
  digestInto(out) {
    aexists(this), aoutput(out, this), this.finished = !0;
    let { buffer, view, blockLen, isLE } = this, { pos } = this;
    if (buffer[pos++] = 128, clean(this.buffer.subarray(pos)), this.padOffset > blockLen - pos)
      this.process(view, 0), pos = 0;
    for (let i = pos;i < blockLen; i++)
      buffer[i] = 0;
    view.setBigUint64(blockLen - 8, BigInt(this.length * 8), isLE), this.process(view, 0);
    let oview = createView(out), len = this.outputLen;
    if (len % 4)
      throw Error("_sha2: outputLen must be aligned to 32bit");
    let outLen = len / 4, state = this.get();
    if (outLen > state.length)
      throw Error("_sha2: outputLen bigger than state");
    for (let i = 0;i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE);
  }
  digest() {
    let { buffer, outputLen } = this;
    this.digestInto(buffer);
    let res = buffer.slice(0, outputLen);
    return this.destroy(), res;
  }
  _cloneInto(to) {
    to ||= new this.constructor, to.set(...this.get());
    let { blockLen, buffer, length, finished, destroyed, pos } = this;
    if (to.destroyed = destroyed, to.finished = finished, to.length = length, to.pos = pos, length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
}
var SHA256_IV = /* @__PURE__ */ Uint32Array.from([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);

// ../../node_modules/.bun/@noble+hashes@2.0.1/node_modules/@noble/hashes/sha2.js
var SHA256_K = /* @__PURE__ */ Uint32Array.from([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]), SHA256_W = /* @__PURE__ */ new Uint32Array(64);

class SHA2_32B extends HashMD {
  constructor(outputLen) {
    super(64, outputLen, 8, !1);
  }
  get() {
    let { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0, this.B = B | 0, this.C = C | 0, this.D = D | 0, this.E = E | 0, this.F = F | 0, this.G = G | 0, this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0;i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, !1);
    for (let i = 16;i < 64; i++) {
      let W15 = SHA256_W[i - 15], W2 = SHA256_W[i - 2], s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3, s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0;i < 64; i++) {
      let sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25), T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0, T2 = (rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22)) + Maj(A, B, C) | 0;
      H = G, G = F, F = E, E = D + T1 | 0, D = C, C = B, B = A, A = T1 + T2 | 0;
    }
    A = A + this.A | 0, B = B + this.B | 0, C = C + this.C | 0, D = D + this.D | 0, E = E + this.E | 0, F = F + this.F | 0, G = G + this.G | 0, H = H + this.H | 0, this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    clean(SHA256_W);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0), clean(this.buffer);
  }
}

class _SHA256 extends SHA2_32B {
  A = SHA256_IV[0] | 0;
  B = SHA256_IV[1] | 0;
  C = SHA256_IV[2] | 0;
  D = SHA256_IV[3] | 0;
  E = SHA256_IV[4] | 0;
  F = SHA256_IV[5] | 0;
  G = SHA256_IV[6] | 0;
  H = SHA256_IV[7] | 0;
  constructor() {
    super(32);
  }
}
var sha256 = /* @__PURE__ */ createHasher(() => new _SHA256, /* @__PURE__ */ oidNist(1));

// ../../node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/utils.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n = /* @__PURE__ */ BigInt(0), _1n = /* @__PURE__ */ BigInt(1);
function abool(value, title = "") {
  if (typeof value !== "boolean") {
    let prefix = title && `"${title}" `;
    throw Error(prefix + "expected boolean, got type=" + typeof value);
  }
  return value;
}
function abignumber(n) {
  if (typeof n === "bigint") {
    if (!isPosBig(n))
      throw Error("positive bigint expected, got " + n);
  } else
    anumber(n);
  return n;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n : BigInt("0x" + hex);
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  return hexToNumber(bytesToHex(copyBytes(abytes(bytes)).reverse()));
}
function numberToBytesBE(n, len) {
  anumber(len), n = abignumber(n);
  let res = hexToBytes(n.toString(16).padStart(len * 2, "0"));
  if (res.length !== len)
    throw Error("number too large");
  return res;
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function copyBytes(bytes) {
  return Uint8Array.from(bytes);
}
function asciiToBytes(ascii) {
  return Uint8Array.from(ascii, (c, i) => {
    let charCode = c.charCodeAt(0);
    if (c.length !== 1 || charCode > 127)
      throw Error(`string contains non-ASCII character "${ascii[i]}" with code ${charCode} at position ${i}`);
    return charCode;
  });
}
var isPosBig = (n) => typeof n === "bigint" && _0n <= n;
function bitLen(n) {
  let len;
  for (len = 0;n > _0n; n >>= _1n, len += 1)
    ;
  return len;
}
var bitMask = (n) => (_1n << BigInt(n)) - _1n;
function validateObject(object, fields = {}, optFields = {}) {
  if (!object || typeof object !== "object")
    throw Error("expected valid options object");
  function checkField(fieldName, expectedType, isOpt) {
    let val = object[fieldName];
    if (isOpt && val === void 0)
      return;
    let current = typeof val;
    if (current !== expectedType || val === null)
      throw Error(`param "${fieldName}" is invalid: expected ${expectedType}, got ${current}`);
  }
  let iter = (f, isOpt) => Object.entries(f).forEach(([k, v]) => checkField(k, v, isOpt));
  iter(fields, !1), iter(optFields, !0);
}
function memoized(fn) {
  let map = /* @__PURE__ */ new WeakMap;
  return (arg, ...args) => {
    let val = map.get(arg);
    if (val !== void 0)
      return val;
    let computed = fn(arg, ...args);
    return map.set(arg, computed), computed;
  };
}

// ../../node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n2 = /* @__PURE__ */ BigInt(0), _1n2 = /* @__PURE__ */ BigInt(1), _2n = /* @__PURE__ */ BigInt(2), _3n = /* @__PURE__ */ BigInt(3), _4n = /* @__PURE__ */ BigInt(4), _5n = /* @__PURE__ */ BigInt(5), _7n = /* @__PURE__ */ BigInt(7), _8n = /* @__PURE__ */ BigInt(8), _9n = /* @__PURE__ */ BigInt(9), _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  let result = a % b;
  return result >= _0n2 ? result : b + result;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n2)
    res *= res, res %= modulo;
  return res;
}
function invert(number, modulo) {
  if (number === _0n2)
    throw Error("invert: expected non-zero number");
  if (modulo <= _0n2)
    throw Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo), b = modulo, x = _0n2, y = _1n2, u = _1n2, v = _0n2;
  while (a !== _0n2) {
    let q = b / a, r = b % a, m = x - u * q, n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  if (b !== _1n2)
    throw Error("invert: does not exist");
  return mod(x, modulo);
}
function assertIsSquare(Fp, root, n) {
  if (!Fp.eql(Fp.sqr(root), n))
    throw Error("Cannot find square root");
}
function sqrt3mod4(Fp, n) {
  let p1div4 = (Fp.ORDER + _1n2) / _4n, root = Fp.pow(n, p1div4);
  return assertIsSquare(Fp, root, n), root;
}
function sqrt5mod8(Fp, n) {
  let p5div8 = (Fp.ORDER - _5n) / _8n, n2 = Fp.mul(n, _2n), v = Fp.pow(n2, p5div8), nv = Fp.mul(n, v), i = Fp.mul(Fp.mul(nv, _2n), v), root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
  return assertIsSquare(Fp, root, n), root;
}
function sqrt9mod16(P) {
  let Fp_ = Field(P), tn = tonelliShanks(P), c1 = tn(Fp_, Fp_.neg(Fp_.ONE)), c2 = tn(Fp_, c1), c3 = tn(Fp_, Fp_.neg(c1)), c4 = (P + _7n) / _16n;
  return (Fp, n) => {
    let tv1 = Fp.pow(n, c4), tv2 = Fp.mul(tv1, c1), tv3 = Fp.mul(tv1, c2), tv4 = Fp.mul(tv1, c3), e1 = Fp.eql(Fp.sqr(tv2), n), e2 = Fp.eql(Fp.sqr(tv3), n);
    tv1 = Fp.cmov(tv1, tv2, e1), tv2 = Fp.cmov(tv4, tv3, e2);
    let e3 = Fp.eql(Fp.sqr(tv2), n), root = Fp.cmov(tv1, tv2, e3);
    return assertIsSquare(Fp, root, n), root;
  };
}
function tonelliShanks(P) {
  if (P < _3n)
    throw Error("sqrt is not defined for small field");
  let Q = P - _1n2, S = 0;
  while (Q % _2n === _0n2)
    Q /= _2n, S++;
  let Z = _2n, _Fp = Field(P);
  while (FpLegendre(_Fp, Z) === 1)
    if (Z++ > 1000)
      throw Error("Cannot find square root: probably non-prime P");
  if (S === 1)
    return sqrt3mod4;
  let cc = _Fp.pow(Z, Q), Q1div2 = (Q + _1n2) / _2n;
  return function(Fp, n) {
    if (Fp.is0(n))
      return n;
    if (FpLegendre(Fp, n) !== 1)
      throw Error("Cannot find square root");
    let M = S, c = Fp.mul(Fp.ONE, cc), t = Fp.pow(n, Q), R = Fp.pow(n, Q1div2);
    while (!Fp.eql(t, Fp.ONE)) {
      if (Fp.is0(t))
        return Fp.ZERO;
      let i = 1, t_tmp = Fp.sqr(t);
      while (!Fp.eql(t_tmp, Fp.ONE))
        if (i++, t_tmp = Fp.sqr(t_tmp), i === M)
          throw Error("Cannot find square root");
      let exponent = _1n2 << BigInt(M - i - 1), b = Fp.pow(c, exponent);
      M = i, c = Fp.sqr(b), t = Fp.mul(t, c), R = Fp.mul(R, b);
    }
    return R;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n)
    return sqrt3mod4;
  if (P % _8n === _5n)
    return sqrt5mod8;
  if (P % _16n === _9n)
    return sqrt9mod16(P);
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  let initial = {
    ORDER: "bigint",
    BYTES: "number",
    BITS: "number"
  }, opts = FIELD_FIELDS.reduce((map, val) => (map[val] = "function", map), initial);
  return validateObject(field, opts), field;
}
function FpPow(Fp, num, power) {
  if (power < _0n2)
    throw Error("invalid exponent, negatives unsupported");
  if (power === _0n2)
    return Fp.ONE;
  if (power === _1n2)
    return num;
  let p = Fp.ONE, d = num;
  while (power > _0n2) {
    if (power & _1n2)
      p = Fp.mul(p, d);
    d = Fp.sqr(d), power >>= _1n2;
  }
  return p;
}
function FpInvertBatch(Fp, nums, passZero = !1) {
  let inverted = Array(nums.length).fill(passZero ? Fp.ZERO : void 0), multipliedAcc = nums.reduce((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    return inverted[i] = acc, Fp.mul(acc, num);
  }, Fp.ONE), invertedAcc = Fp.inv(multipliedAcc);
  return nums.reduceRight((acc, num, i) => {
    if (Fp.is0(num))
      return acc;
    return inverted[i] = Fp.mul(acc, inverted[i]), Fp.mul(acc, num);
  }, invertedAcc), inverted;
}
function FpLegendre(Fp, n) {
  let p1mod2 = (Fp.ORDER - _1n2) / _2n, powered = Fp.pow(n, p1mod2), yes = Fp.eql(powered, Fp.ONE), zero = Fp.eql(powered, Fp.ZERO), no = Fp.eql(powered, Fp.neg(Fp.ONE));
  if (!yes && !zero && !no)
    throw Error("invalid Legendre symbol result");
  return yes ? 1 : zero ? 0 : -1;
}
function nLength(n, nBitLength) {
  if (nBitLength !== void 0)
    anumber(nBitLength);
  let _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length, nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}

class _Field {
  ORDER;
  BITS;
  BYTES;
  isLE;
  ZERO = _0n2;
  ONE = _1n2;
  _lengths;
  _sqrt;
  _mod;
  constructor(ORDER, opts = {}) {
    if (ORDER <= _0n2)
      throw Error("invalid field: expected ORDER > 0, got " + ORDER);
    let _nbitLength = void 0;
    if (this.isLE = !1, opts != null && typeof opts === "object") {
      if (typeof opts.BITS === "number")
        _nbitLength = opts.BITS;
      if (typeof opts.sqrt === "function")
        this.sqrt = opts.sqrt;
      if (typeof opts.isLE === "boolean")
        this.isLE = opts.isLE;
      if (opts.allowedLengths)
        this._lengths = opts.allowedLengths?.slice();
      if (typeof opts.modFromBytes === "boolean")
        this._mod = opts.modFromBytes;
    }
    let { nBitLength, nByteLength } = nLength(ORDER, _nbitLength);
    if (nByteLength > 2048)
      throw Error("invalid field: expected ORDER of <= 2048 bytes");
    this.ORDER = ORDER, this.BITS = nBitLength, this.BYTES = nByteLength, this._sqrt = void 0, Object.preventExtensions(this);
  }
  create(num) {
    return mod(num, this.ORDER);
  }
  isValid(num) {
    if (typeof num !== "bigint")
      throw Error("invalid field element: expected bigint, got " + typeof num);
    return _0n2 <= num && num < this.ORDER;
  }
  is0(num) {
    return num === _0n2;
  }
  isValidNot0(num) {
    return !this.is0(num) && this.isValid(num);
  }
  isOdd(num) {
    return (num & _1n2) === _1n2;
  }
  neg(num) {
    return mod(-num, this.ORDER);
  }
  eql(lhs, rhs) {
    return lhs === rhs;
  }
  sqr(num) {
    return mod(num * num, this.ORDER);
  }
  add(lhs, rhs) {
    return mod(lhs + rhs, this.ORDER);
  }
  sub(lhs, rhs) {
    return mod(lhs - rhs, this.ORDER);
  }
  mul(lhs, rhs) {
    return mod(lhs * rhs, this.ORDER);
  }
  pow(num, power) {
    return FpPow(this, num, power);
  }
  div(lhs, rhs) {
    return mod(lhs * invert(rhs, this.ORDER), this.ORDER);
  }
  sqrN(num) {
    return num * num;
  }
  addN(lhs, rhs) {
    return lhs + rhs;
  }
  subN(lhs, rhs) {
    return lhs - rhs;
  }
  mulN(lhs, rhs) {
    return lhs * rhs;
  }
  inv(num) {
    return invert(num, this.ORDER);
  }
  sqrt(num) {
    if (!this._sqrt)
      this._sqrt = FpSqrt(this.ORDER);
    return this._sqrt(this, num);
  }
  toBytes(num) {
    return this.isLE ? numberToBytesLE(num, this.BYTES) : numberToBytesBE(num, this.BYTES);
  }
  fromBytes(bytes, skipValidation = !1) {
    abytes(bytes);
    let { _lengths: allowedLengths, BYTES, isLE, ORDER, _mod: modFromBytes } = this;
    if (allowedLengths) {
      if (!allowedLengths.includes(bytes.length) || bytes.length > BYTES)
        throw Error("Field.fromBytes: expected " + allowedLengths + " bytes, got " + bytes.length);
      let padded = new Uint8Array(BYTES);
      padded.set(bytes, isLE ? 0 : padded.length - bytes.length), bytes = padded;
    }
    if (bytes.length !== BYTES)
      throw Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
    let scalar = isLE ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    if (modFromBytes)
      scalar = mod(scalar, ORDER);
    if (!skipValidation) {
      if (!this.isValid(scalar))
        throw Error("invalid field element: outside of range 0..ORDER");
    }
    return scalar;
  }
  invertBatch(lst) {
    return FpInvertBatch(this, lst);
  }
  cmov(a, b, condition) {
    return condition ? b : a;
  }
}
function Field(ORDER, opts = {}) {
  return new _Field(ORDER, opts);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw Error("field order must be bigint");
  let bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  let length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key, fieldOrder, isLE = !1) {
  abytes(key);
  let len = key.length, fieldLen = getFieldBytesLength(fieldOrder), minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw Error("expected " + minLen + "-1024 bytes of input, got " + len);
  let num = isLE ? bytesToNumberLE(key) : bytesToNumberBE(key), reduced = mod(num, fieldOrder - _1n2) + _1n2;
  return isLE ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// ../../node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/curve.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var _0n3 = /* @__PURE__ */ BigInt(0), _1n3 = /* @__PURE__ */ BigInt(1);
function negateCt(condition, item) {
  let neg = item.negate();
  return condition ? neg : item;
}
function normalizeZ(c, points) {
  let invertedZs = FpInvertBatch(c.Fp, points.map((p) => p.Z));
  return points.map((p, i) => c.fromAffine(p.toAffine(invertedZs[i])));
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, scalarBits) {
  validateW(W, scalarBits);
  let windows = Math.ceil(scalarBits / W) + 1, windowSize = 2 ** (W - 1), maxNumber = 2 ** W, mask = bitMask(W), shiftBy = BigInt(W);
  return { windows, windowSize, mask, maxNumber, shiftBy };
}
function calcOffsets(n, window, wOpts) {
  let { windowSize, mask, maxNumber, shiftBy } = wOpts, wbits = Number(n & mask), nextN = n >> shiftBy;
  if (wbits > windowSize)
    wbits -= maxNumber, nextN += _1n3;
  let offsetStart = window * windowSize, offset = offsetStart + Math.abs(wbits) - 1, isZero = wbits === 0, isNeg = wbits < 0, isNegF = window % 2 !== 0;
  return { nextN, offset, isZero, isNeg, isNegF, offsetF: offsetStart };
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap, pointWindowSizes = /* @__PURE__ */ new WeakMap;
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function assert0(n) {
  if (n !== _0n3)
    throw Error("invalid wNAF");
}

class wNAF {
  BASE;
  ZERO;
  Fn;
  bits;
  constructor(Point, bits) {
    this.BASE = Point.BASE, this.ZERO = Point.ZERO, this.Fn = Point.Fn, this.bits = bits;
  }
  _unsafeLadder(elm, n, p = this.ZERO) {
    let d = elm;
    while (n > _0n3) {
      if (n & _1n3)
        p = p.add(d);
      d = d.double(), n >>= _1n3;
    }
    return p;
  }
  precomputeWindow(point, W) {
    let { windows, windowSize } = calcWOpts(W, this.bits), points = [], p = point, base = p;
    for (let window = 0;window < windows; window++) {
      base = p, points.push(base);
      for (let i = 1;i < windowSize; i++)
        base = base.add(p), points.push(base);
      p = base.double();
    }
    return points;
  }
  wNAF(W, precomputes, n) {
    if (!this.Fn.isValid(n))
      throw Error("invalid scalar");
    let p = this.ZERO, f = this.BASE, wo = calcWOpts(W, this.bits);
    for (let window = 0;window < wo.windows; window++) {
      let { nextN, offset, isZero, isNeg, isNegF, offsetF } = calcOffsets(n, window, wo);
      if (n = nextN, isZero)
        f = f.add(negateCt(isNegF, precomputes[offsetF]));
      else
        p = p.add(negateCt(isNeg, precomputes[offset]));
    }
    return assert0(n), { p, f };
  }
  wNAFUnsafe(W, precomputes, n, acc = this.ZERO) {
    let wo = calcWOpts(W, this.bits);
    for (let window = 0;window < wo.windows; window++) {
      if (n === _0n3)
        break;
      let { nextN, offset, isZero, isNeg } = calcOffsets(n, window, wo);
      if (n = nextN, isZero)
        continue;
      else {
        let item = precomputes[offset];
        acc = acc.add(isNeg ? item.negate() : item);
      }
    }
    return assert0(n), acc;
  }
  getPrecomputes(W, point, transform) {
    let comp = pointPrecomputes.get(point);
    if (!comp) {
      if (comp = this.precomputeWindow(point, W), W !== 1) {
        if (typeof transform === "function")
          comp = transform(comp);
        pointPrecomputes.set(point, comp);
      }
    }
    return comp;
  }
  cached(point, scalar, transform) {
    let W = getW(point);
    return this.wNAF(W, this.getPrecomputes(W, point, transform), scalar);
  }
  unsafe(point, scalar, transform, prev) {
    let W = getW(point);
    if (W === 1)
      return this._unsafeLadder(point, scalar, prev);
    return this.wNAFUnsafe(W, this.getPrecomputes(W, point, transform), scalar, prev);
  }
  createCache(P, W) {
    validateW(W, this.bits), pointWindowSizes.set(P, W), pointPrecomputes.delete(P);
  }
  hasCache(elm) {
    return getW(elm) !== 1;
  }
}
function mulEndoUnsafe(Point, point, k1, k2) {
  let acc = point, { ZERO: p1, ZERO: p2 } = Point;
  while (k1 > _0n3 || k2 > _0n3) {
    if (k1 & _1n3)
      p1 = p1.add(acc);
    if (k2 & _1n3)
      p2 = p2.add(acc);
    acc = acc.double(), k1 >>= _1n3, k2 >>= _1n3;
  }
  return { p1, p2 };
}
function createField(order, field, isLE) {
  if (field) {
    if (field.ORDER !== order)
      throw Error("Field.ORDER must match order: Fp == p, Fn == n");
    return validateField(field), field;
  } else
    return Field(order, { isLE });
}
function createCurveFields(type, CURVE, curveOpts = {}, FpFnLE) {
  if (FpFnLE === void 0)
    FpFnLE = type === "edwards";
  if (!CURVE || typeof CURVE !== "object")
    throw Error(`expected valid ${type} CURVE object`);
  for (let p of ["p", "n", "h"]) {
    let val = CURVE[p];
    if (!(typeof val === "bigint" && val > _0n3))
      throw Error(`CURVE.${p} must be positive bigint`);
  }
  let Fp = createField(CURVE.p, curveOpts.Fp, FpFnLE), Fn = createField(CURVE.n, curveOpts.Fn, FpFnLE), params = ["Gx", "Gy", "a", type === "weierstrass" ? "b" : "d"];
  for (let p of params)
    if (!Fp.isValid(CURVE[p]))
      throw Error(`CURVE.${p} must be valid field element of CURVE.Fp`);
  return CURVE = Object.freeze(Object.assign({}, CURVE)), { CURVE, Fp, Fn };
}
function createKeygen(randomSecretKey, getPublicKey) {
  return function(seed) {
    let secretKey = randomSecretKey(seed);
    return { secretKey, publicKey: getPublicKey(secretKey) };
  };
}

// ../../node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/abstract/weierstrass.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var divNearest = (num, den) => (num + (num >= 0 ? den : -den) / _2n2) / den;
function _splitEndoScalar(k, basis, n) {
  let [[a1, b1], [a2, b2]] = basis, c1 = divNearest(b2 * k, n), c2 = divNearest(-b1 * k, n), k1 = k - c1 * a1 - c2 * a2, k2 = -c1 * b1 - c2 * b2, k1neg = k1 < _0n4, k2neg = k2 < _0n4;
  if (k1neg)
    k1 = -k1;
  if (k2neg)
    k2 = -k2;
  let MAX_NUM = bitMask(Math.ceil(bitLen(n) / 2)) + _1n4;
  if (k1 < _0n4 || k1 >= MAX_NUM || k2 < _0n4 || k2 >= MAX_NUM)
    throw Error("splitScalar (endomorphism): failed, k=" + k);
  return { k1neg, k1, k2neg, k2 };
}
var _0n4 = BigInt(0), _1n4 = BigInt(1), _2n2 = BigInt(2), _3n2 = BigInt(3), _4n2 = BigInt(4);
function weierstrass(params, extraOpts = {}) {
  let validated = createCurveFields("weierstrass", params, extraOpts), { Fp, Fn } = validated, CURVE = validated.CURVE, { h: cofactor, n: CURVE_ORDER } = CURVE;
  validateObject(extraOpts, {}, {
    allowInfinityPoint: "boolean",
    clearCofactor: "function",
    isTorsionFree: "function",
    fromBytes: "function",
    toBytes: "function",
    endo: "object"
  });
  let { endo } = extraOpts;
  if (endo) {
    if (!Fp.is0(CURVE.a) || typeof endo.beta !== "bigint" || !Array.isArray(endo.basises))
      throw Error('invalid endo: expected "beta": bigint and "basises": array');
  }
  let lengths = getWLengths(Fp, Fn);
  function assertCompressionIsSupported() {
    if (!Fp.isOdd)
      throw Error("compression is not supported: Field does not have .isOdd()");
  }
  function pointToBytes(_c, point, isCompressed) {
    let { x, y } = point.toAffine(), bx = Fp.toBytes(x);
    if (abool(isCompressed, "isCompressed"), isCompressed) {
      assertCompressionIsSupported();
      let hasEvenY = !Fp.isOdd(y);
      return concatBytes(pprefix(hasEvenY), bx);
    } else
      return concatBytes(Uint8Array.of(4), bx, Fp.toBytes(y));
  }
  function pointFromBytes(bytes) {
    abytes(bytes, void 0, "Point");
    let { publicKey: comp, publicKeyUncompressed: uncomp } = lengths, length = bytes.length, head = bytes[0], tail = bytes.subarray(1);
    if (length === comp && (head === 2 || head === 3)) {
      let x = Fp.fromBytes(tail);
      if (!Fp.isValid(x))
        throw Error("bad point: is not on curve, wrong x");
      let y2 = weierstrassEquation(x), y;
      try {
        y = Fp.sqrt(y2);
      } catch (sqrtError) {
        let err = sqrtError instanceof Error ? ": " + sqrtError.message : "";
        throw Error("bad point: is not on curve, sqrt error" + err);
      }
      assertCompressionIsSupported();
      let evenY = Fp.isOdd(y);
      if ((head & 1) === 1 !== evenY)
        y = Fp.neg(y);
      return { x, y };
    } else if (length === uncomp && head === 4) {
      let L = Fp.BYTES, x = Fp.fromBytes(tail.subarray(0, L)), y = Fp.fromBytes(tail.subarray(L, L * 2));
      if (!isValidXY(x, y))
        throw Error("bad point: is not on curve");
      return { x, y };
    } else
      throw Error(`bad point: got length ${length}, expected compressed=${comp} or uncompressed=${uncomp}`);
  }
  let encodePoint = extraOpts.toBytes || pointToBytes, decodePoint = extraOpts.fromBytes || pointFromBytes;
  function weierstrassEquation(x) {
    let x2 = Fp.sqr(x), x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, CURVE.a)), CURVE.b);
  }
  function isValidXY(x, y) {
    let left = Fp.sqr(y), right = weierstrassEquation(x);
    return Fp.eql(left, right);
  }
  if (!isValidXY(CURVE.Gx, CURVE.Gy))
    throw Error("bad curve params: generator point");
  let _4a3 = Fp.mul(Fp.pow(CURVE.a, _3n2), _4n2), _27b2 = Fp.mul(Fp.sqr(CURVE.b), BigInt(27));
  if (Fp.is0(Fp.add(_4a3, _27b2)))
    throw Error("bad curve params: a or b");
  function acoord(title, n, banZero = !1) {
    if (!Fp.isValid(n) || banZero && Fp.is0(n))
      throw Error(`bad point coordinate ${title}`);
    return n;
  }
  function aprjpoint(other) {
    if (!(other instanceof Point))
      throw Error("Weierstrass Point expected");
  }
  function splitEndoScalarN(k) {
    if (!endo || !endo.basises)
      throw Error("no endo");
    return _splitEndoScalar(k, endo.basises, Fn.ORDER);
  }
  let toAffineMemo = memoized((p, iz) => {
    let { X, Y, Z } = p;
    if (Fp.eql(Z, Fp.ONE))
      return { x: X, y: Y };
    let is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(Z);
    let x = Fp.mul(X, iz), y = Fp.mul(Y, iz), zz = Fp.mul(Z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw Error("invZ was invalid");
    return { x, y };
  }), assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (extraOpts.allowInfinityPoint && !Fp.is0(p.Y))
        return;
      throw Error("bad point: ZERO");
    }
    let { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw Error("bad point: x or y not field elements");
    if (!isValidXY(x, y))
      throw Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw Error("bad point: not in prime-order subgroup");
    return !0;
  });
  function finishEndo(endoBeta, k1p, k2p, k1neg, k2neg) {
    return k2p = new Point(Fp.mul(k2p.X, endoBeta), k2p.Y, k2p.Z), k1p = negateCt(k1neg, k1p), k2p = negateCt(k2neg, k2p), k1p.add(k2p);
  }

  class Point {
    static BASE = new Point(CURVE.Gx, CURVE.Gy, Fp.ONE);
    static ZERO = new Point(Fp.ZERO, Fp.ONE, Fp.ZERO);
    static Fp = Fp;
    static Fn = Fn;
    X;
    Y;
    Z;
    constructor(X, Y, Z) {
      this.X = acoord("x", X), this.Y = acoord("y", Y, !0), this.Z = acoord("z", Z), Object.freeze(this);
    }
    static CURVE() {
      return CURVE;
    }
    static fromAffine(p) {
      let { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw Error("invalid affine point");
      if (p instanceof Point)
        throw Error("projective point not allowed");
      if (Fp.is0(x) && Fp.is0(y))
        return Point.ZERO;
      return new Point(x, y, Fp.ONE);
    }
    static fromBytes(bytes) {
      let P = Point.fromAffine(decodePoint(abytes(bytes, void 0, "point")));
      return P.assertValidity(), P;
    }
    static fromHex(hex) {
      return Point.fromBytes(hexToBytes(hex));
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    precompute(windowSize = 8, isLazy = !0) {
      if (wnaf.createCache(this, windowSize), !isLazy)
        this.multiply(_3n2);
      return this;
    }
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      let { y } = this.toAffine();
      if (!Fp.isOdd)
        throw Error("Field doesn't support isOdd");
      return !Fp.isOdd(y);
    }
    equals(other) {
      aprjpoint(other);
      let { X: X1, Y: Y1, Z: Z1 } = this, { X: X2, Y: Y2, Z: Z2 } = other, U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1)), U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    negate() {
      return new Point(this.X, Fp.neg(this.Y), this.Z);
    }
    double() {
      let { a, b } = CURVE, b3 = Fp.mul(b, _3n2), { X: X1, Y: Y1, Z: Z1 } = this, { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp, t0 = Fp.mul(X1, X1), t1 = Fp.mul(Y1, Y1), t2 = Fp.mul(Z1, Z1), t3 = Fp.mul(X1, Y1);
      return t3 = Fp.add(t3, t3), Z3 = Fp.mul(X1, Z1), Z3 = Fp.add(Z3, Z3), X3 = Fp.mul(a, Z3), Y3 = Fp.mul(b3, t2), Y3 = Fp.add(X3, Y3), X3 = Fp.sub(t1, Y3), Y3 = Fp.add(t1, Y3), Y3 = Fp.mul(X3, Y3), X3 = Fp.mul(t3, X3), Z3 = Fp.mul(b3, Z3), t2 = Fp.mul(a, t2), t3 = Fp.sub(t0, t2), t3 = Fp.mul(a, t3), t3 = Fp.add(t3, Z3), Z3 = Fp.add(t0, t0), t0 = Fp.add(Z3, t0), t0 = Fp.add(t0, t2), t0 = Fp.mul(t0, t3), Y3 = Fp.add(Y3, t0), t2 = Fp.mul(Y1, Z1), t2 = Fp.add(t2, t2), t0 = Fp.mul(t2, t3), X3 = Fp.sub(X3, t0), Z3 = Fp.mul(t2, t1), Z3 = Fp.add(Z3, Z3), Z3 = Fp.add(Z3, Z3), new Point(X3, Y3, Z3);
    }
    add(other) {
      aprjpoint(other);
      let { X: X1, Y: Y1, Z: Z1 } = this, { X: X2, Y: Y2, Z: Z2 } = other, { ZERO: X3, ZERO: Y3, ZERO: Z3 } = Fp, a = CURVE.a, b3 = Fp.mul(CURVE.b, _3n2), t0 = Fp.mul(X1, X2), t1 = Fp.mul(Y1, Y2), t2 = Fp.mul(Z1, Z2), t3 = Fp.add(X1, Y1), t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4), t4 = Fp.add(t0, t1), t3 = Fp.sub(t3, t4), t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      return t4 = Fp.mul(t4, t5), t5 = Fp.add(t0, t2), t4 = Fp.sub(t4, t5), t5 = Fp.add(Y1, Z1), X3 = Fp.add(Y2, Z2), t5 = Fp.mul(t5, X3), X3 = Fp.add(t1, t2), t5 = Fp.sub(t5, X3), Z3 = Fp.mul(a, t4), X3 = Fp.mul(b3, t2), Z3 = Fp.add(X3, Z3), X3 = Fp.sub(t1, Z3), Z3 = Fp.add(t1, Z3), Y3 = Fp.mul(X3, Z3), t1 = Fp.add(t0, t0), t1 = Fp.add(t1, t0), t2 = Fp.mul(a, t2), t4 = Fp.mul(b3, t4), t1 = Fp.add(t1, t2), t2 = Fp.sub(t0, t2), t2 = Fp.mul(a, t2), t4 = Fp.add(t4, t2), t0 = Fp.mul(t1, t4), Y3 = Fp.add(Y3, t0), t0 = Fp.mul(t5, t4), X3 = Fp.mul(t3, X3), X3 = Fp.sub(X3, t0), t0 = Fp.mul(t3, t1), Z3 = Fp.mul(t5, Z3), Z3 = Fp.add(Z3, t0), new Point(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point.ZERO);
    }
    multiply(scalar) {
      let { endo } = extraOpts;
      if (!Fn.isValidNot0(scalar))
        throw Error("invalid scalar: out of range");
      let point, fake, mul = (n) => wnaf.cached(this, n, (p) => normalizeZ(Point, p));
      if (endo) {
        let { k1neg, k1, k2neg, k2 } = splitEndoScalarN(scalar), { p: k1p, f: k1f } = mul(k1), { p: k2p, f: k2f } = mul(k2);
        fake = k1f.add(k2f), point = finishEndo(endo.beta, k1p, k2p, k1neg, k2neg);
      } else {
        let { p, f } = mul(scalar);
        point = p, fake = f;
      }
      return normalizeZ(Point, [point, fake])[0];
    }
    multiplyUnsafe(sc) {
      let { endo } = extraOpts, p = this;
      if (!Fn.isValid(sc))
        throw Error("invalid scalar: out of range");
      if (sc === _0n4 || p.is0())
        return Point.ZERO;
      if (sc === _1n4)
        return p;
      if (wnaf.hasCache(this))
        return this.multiply(sc);
      if (endo) {
        let { k1neg, k1, k2neg, k2 } = splitEndoScalarN(sc), { p1, p2 } = mulEndoUnsafe(Point, p, k1, k2);
        return finishEndo(endo.beta, p1, p2, k1neg, k2neg);
      } else
        return wnaf.unsafe(p, sc);
    }
    toAffine(invertedZ) {
      return toAffineMemo(this, invertedZ);
    }
    isTorsionFree() {
      let { isTorsionFree } = extraOpts;
      if (cofactor === _1n4)
        return !0;
      if (isTorsionFree)
        return isTorsionFree(Point, this);
      return wnaf.unsafe(this, CURVE_ORDER).is0();
    }
    clearCofactor() {
      let { clearCofactor } = extraOpts;
      if (cofactor === _1n4)
        return this;
      if (clearCofactor)
        return clearCofactor(Point, this);
      return this.multiplyUnsafe(cofactor);
    }
    isSmallOrder() {
      return this.multiplyUnsafe(cofactor).is0();
    }
    toBytes(isCompressed = !0) {
      return abool(isCompressed, "isCompressed"), this.assertValidity(), encodePoint(Point, this, isCompressed);
    }
    toHex(isCompressed = !0) {
      return bytesToHex(this.toBytes(isCompressed));
    }
    toString() {
      return `<Point ${this.is0() ? "ZERO" : this.toHex()}>`;
    }
  }
  let bits = Fn.BITS, wnaf = new wNAF(Point, extraOpts.endo ? Math.ceil(bits / 2) : bits);
  return Point.BASE.precompute(8), Point;
}
function pprefix(hasEvenY) {
  return Uint8Array.of(hasEvenY ? 2 : 3);
}
function getWLengths(Fp, Fn) {
  return {
    secretKey: Fn.BYTES,
    publicKey: 1 + Fp.BYTES,
    publicKeyUncompressed: 1 + 2 * Fp.BYTES,
    publicKeyHasPrefix: !0,
    signature: 2 * Fn.BYTES
  };
}

// ../../node_modules/.bun/@noble+curves@2.0.1/node_modules/@noble/curves/secp256k1.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */
var secp256k1_CURVE = {
  p: BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f"),
  n: BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"),
  h: BigInt(1),
  a: BigInt(0),
  b: BigInt(7),
  Gx: BigInt("0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"),
  Gy: BigInt("0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8")
}, secp256k1_ENDO = {
  beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
  basises: [
    [BigInt("0x3086d221a7d46bcde86c90e49284eb15"), -BigInt("0xe4437ed6010e88286f547fa90abfe4c3")],
    [BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8"), BigInt("0x3086d221a7d46bcde86c90e49284eb15")]
  ]
}, _0n5 = /* @__PURE__ */ BigInt(0), _2n3 = /* @__PURE__ */ BigInt(2);
function sqrtMod(y) {
  let P = secp256k1_CURVE.p, _3n = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22), _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88), b2 = y * y * y % P, b3 = b2 * b2 * y % P, b6 = pow2(b3, _3n, P) * b3 % P, b9 = pow2(b6, _3n, P) * b3 % P, b11 = pow2(b9, _2n3, P) * b2 % P, b22 = pow2(b11, _11n, P) * b11 % P, b44 = pow2(b22, _22n, P) * b22 % P, b88 = pow2(b44, _44n, P) * b44 % P, b176 = pow2(b88, _88n, P) * b88 % P, b220 = pow2(b176, _44n, P) * b44 % P, b223 = pow2(b220, _3n, P) * b3 % P, t1 = pow2(b223, _23n, P) * b22 % P, t2 = pow2(t1, _6n, P) * b2 % P, root = pow2(t2, _2n3, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw Error("Cannot find square root");
  return root;
}
var Fpk1 = Field(secp256k1_CURVE.p, { sqrt: sqrtMod }), Pointk1 = /* @__PURE__ */ weierstrass(secp256k1_CURVE, {
  Fp: Fpk1,
  endo: secp256k1_ENDO
});
var TAGGED_HASH_PREFIXES = {};
function taggedHash(tag, ...messages) {
  let tagP = TAGGED_HASH_PREFIXES[tag];
  if (tagP === void 0) {
    let tagH = sha256(asciiToBytes(tag));
    tagP = concatBytes(tagH, tagH), TAGGED_HASH_PREFIXES[tag] = tagP;
  }
  return sha256(concatBytes(tagP, ...messages));
}
var pointToBytes = (point) => point.toBytes(!0).slice(1), hasEven = (y) => y % _2n3 === _0n5;
function schnorrGetExtPubKey(priv) {
  let { Fn, BASE } = Pointk1, d_ = Fn.fromBytes(priv), p = BASE.multiply(d_);
  return { scalar: hasEven(p.y) ? d_ : Fn.neg(d_), bytes: pointToBytes(p) };
}
function lift_x(x) {
  let Fp = Fpk1;
  if (!Fp.isValidNot0(x))
    throw Error("invalid x: Fail if x ≥ p");
  let xx = Fp.create(x * x), c = Fp.create(xx * x + BigInt(7)), y = Fp.sqrt(c);
  if (!hasEven(y))
    y = Fp.neg(y);
  let p = Pointk1.fromAffine({ x, y });
  return p.assertValidity(), p;
}
var num = bytesToNumberBE;
function challenge(...args) {
  return Pointk1.Fn.create(num(taggedHash("BIP0340/challenge", ...args)));
}
function schnorrGetPublicKey(secretKey) {
  return schnorrGetExtPubKey(secretKey).bytes;
}
function schnorrSign(message, secretKey, auxRand = randomBytes(32)) {
  let { Fn } = Pointk1, m = abytes(message, void 0, "message"), { bytes: px, scalar: d } = schnorrGetExtPubKey(secretKey), a = abytes(auxRand, 32, "auxRand"), t = Fn.toBytes(d ^ num(taggedHash("BIP0340/aux", a))), rand = taggedHash("BIP0340/nonce", t, px, m), { bytes: rx, scalar: k } = schnorrGetExtPubKey(rand), e = challenge(rx, px, m), sig = new Uint8Array(64);
  if (sig.set(rx, 0), sig.set(Fn.toBytes(Fn.create(k + e * d)), 32), !schnorrVerify(sig, m, px))
    throw Error("sign: Invalid signature produced");
  return sig;
}
function schnorrVerify(signature, message, publicKey) {
  let { Fp, Fn, BASE } = Pointk1, sig = abytes(signature, 64, "signature"), m = abytes(message, void 0, "message"), pub = abytes(publicKey, 32, "publicKey");
  try {
    let P = lift_x(num(pub)), r = num(sig.subarray(0, 32));
    if (!Fp.isValidNot0(r))
      return !1;
    let s = num(sig.subarray(32, 64));
    if (!Fn.isValidNot0(s))
      return !1;
    let e = challenge(Fn.toBytes(r), pointToBytes(P), m), R = BASE.multiplyUnsafe(s).add(P.multiplyUnsafe(Fn.neg(e))), { x, y } = R.toAffine();
    if (R.is0() || !hasEven(y) || x !== r)
      return !1;
    return !0;
  } catch (error) {
    return !1;
  }
}
var schnorr = /* @__PURE__ */ (() => {
  let randomSecretKey = (seed = randomBytes(48)) => mapHashToField(seed, secp256k1_CURVE.n);
  return {
    keygen: createKeygen(randomSecretKey, schnorrGetPublicKey),
    getPublicKey: schnorrGetPublicKey,
    sign: schnorrSign,
    verify: schnorrVerify,
    Point: Pointk1,
    utils: {
      randomSecretKey,
      taggedHash,
      lift_x,
      pointToBytes
    },
    lengths: {
      secretKey: 32,
      publicKey: 32,
      publicKeyHasPrefix: !1,
      signature: 64,
      seed: 48
    }
  };
})();

// ../core/src/pipeline/schnorr.ts
var HEX64 = /^[0-9a-f]{64}$/, HEX128 = /^[0-9a-f]{128}$/;
function schnorrOk(id, pubkey, sig) {
  if (!HEX64.test(id) || !HEX64.test(pubkey) || !HEX128.test(sig))
    return !1;
  try {
    return schnorr.verify(Buffer.from(sig, "hex"), Buffer.from(id, "hex"), Buffer.from(pubkey, "hex"));
  } catch {
    return !1;
  }
}

// ../core/src/pipeline/verify-worker.ts
parentPort?.on("message", (msg) => {
  parentPort.postMessage({ id: msg.id, ok: msg.items.map(([id, pubkey, sig]) => schnorrOk(id, pubkey, sig)) });
});
