/**
 * Static safety check for admin-supplied word-filter regexes. Filters run synchronously on every event, so a
 * pattern that backtracks heavily (e.g. `^(\w+\s?)+$`, or `\w+\.?\w+x` on a long run of letters) lets anyone
 * freeze the relay with crafted content. The pattern is parsed and its worst-case backtracking work is bounded
 * from above; each filter is then run on at most as much content at once as keeps that bound within a fixed step
 * budget (see compileRegexFilter for how longer posts are scanned), and patterns that can't cover even
 * REGEX_FILTER_MIN_INPUT characters within it are refused. The bound is deliberately conservative: it refuses
 * patterns that *could* blow up rather than proving they do.
 */
export const MAX_FILTER_PATTERN_LENGTH = 512;
/** A regex filter is never run on more than this many characters at once. */
export const REGEX_FILTER_MAX_INPUT = 8192;
/** Patterns whose worst case only fits the budget on less content than this are refused. */
export const REGEX_FILTER_MIN_INPUT = 1024;
/** Worst-case backtracking steps one filter may cost per event (a few milliseconds on Bun). */
export const REGEX_FILTER_STEP_BUDGET = 10_000_000;

/** Characters an atom can match: exact for ASCII, plus a flag for "possibly something beyond ASCII". */
interface CharSet {
  ascii: Uint32Array;
  other: boolean;
}

type Node =
  | { t: "char"; set: CharSet }
  | { t: "zero" }
  | { t: "look"; body: Node[][] }
  | { t: "group"; body: Node[][] }
  | { t: "quant"; item: Node; min: number; max: number };

class Refused extends Error {}

const emptySet = (other = false): CharSet => ({ ascii: new Uint32Array(4), other });
const anySet = (): CharSet => {
  const s = emptySet(true);
  s.ascii.fill(0xffffffff);
  return s;
};
function addRange(s: CharSet, from: number, to: number) {
  for (let c = from; c <= Math.min(to, 127); c++) s.ascii[c >> 5] |= 1 << (c & 31);
  if (to > 127) s.other = true;
}
const has = (s: CharSet, c: number) => (s.ascii[c >> 5] & (1 << (c & 31))) !== 0;
function union(a: CharSet, b: CharSet): CharSet {
  const s = emptySet(a.other || b.other);
  for (let i = 0; i < 4; i++) s.ascii[i] = a.ascii[i] | b.ascii[i];
  return s;
}
function complement(a: CharSet): CharSet {
  const s = emptySet(true);
  for (let i = 0; i < 4; i++) s.ascii[i] = ~a.ascii[i];
  return s;
}
/** Filters compile with the `i` flag: letters match both cases (and k/s also fold to non-ASCII K/ſ under `u`). */
function caseFold(s: CharSet): CharSet {
  for (let c = 65; c <= 90; c++) {
    if (has(s, c) || has(s, c + 32)) {
      addRange(s, c, c);
      addRange(s, c + 32, c + 32);
      if (c === 75 || c === 83) s.other = true;
    }
  }
  return s;
}
function disjoint(a: CharSet, b: CharSet): boolean {
  for (let i = 0; i < 4; i++) if (a.ascii[i] & b.ascii[i]) return false;
  return !(a.other && b.other);
}
const single = (code: number) => {
  const s = emptySet();
  addRange(s, code, code);
  return s;
};
const DIGIT = (() => {
  const s = emptySet();
  addRange(s, 48, 57);
  return s;
})();
const WORD = (() => {
  const s = emptySet();
  addRange(s, 48, 57);
  addRange(s, 65, 90);
  addRange(s, 97, 122);
  addRange(s, 95, 95);
  return s;
})();
const SPACE = (() => {
  const s = emptySet(true);
  for (const c of [9, 10, 11, 12, 13, 32]) addRange(s, c, c);
  return s;
})();

/** Recursive-descent parser for the subset of JS regex syntax that matters for backtracking cost. */
class Parser {
  i = 0;
  constructor(private readonly p: string) {}

  parse(): Node[][] {
    const alt = this.alternation();
    if (this.i < this.p.length) throw new Refused("unbalanced parenthesis");
    return alt;
  }

  private alternation(): Node[][] {
    const branches: Node[][] = [this.sequence()];
    while (this.p[this.i] === "|") {
      this.i++;
      branches.push(this.sequence());
    }
    return branches;
  }

  private sequence(): Node[] {
    const seq: Node[] = [];
    while (this.i < this.p.length && this.p[this.i] !== "|" && this.p[this.i] !== ")") {
      const atom = this.atom();
      seq.push(this.quantifier(atom) ?? atom);
    }
    return seq;
  }

  private quantifier(item: Node): Node | undefined {
    const ch = this.p[this.i];
    let min: number, max: number;
    if (ch === "*") [min, max] = [0, Infinity];
    else if (ch === "+") [min, max] = [1, Infinity];
    else if (ch === "?") [min, max] = [0, 1];
    else if (ch === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(this.p.slice(this.i));
      if (!m) return undefined;
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
      this.i += m[0].length - 1;
    } else return undefined;
    this.i++;
    if (this.p[this.i] === "?") this.i++; // lazy: same worst case
    return { t: "quant", item, min, max };
  }

  private atom(): Node {
    const p = this.p;
    const ch = p[this.i];
    if (ch === "(") {
      this.i++;
      let look = false;
      if (p[this.i] === "?") {
        const rest = p.slice(this.i + 1);
        if (rest.startsWith("=") || rest.startsWith("!")) [look, this.i] = [true, this.i + 2];
        else if (rest.startsWith("<=") || rest.startsWith("<!")) [look, this.i] = [true, this.i + 3];
        else if (rest.startsWith("<")) {
          const end = p.indexOf(">", this.i);
          this.i = end === -1 ? p.length : end + 1;
        } else {
          // (?: and modifier groups like (?i:…)
          const end = p.indexOf(":", this.i);
          this.i = end === -1 ? p.length : end + 1;
        }
      }
      const body = this.alternation();
      if (p[this.i] !== ")") throw new Refused("unbalanced parenthesis");
      this.i++;
      return look ? { t: "look", body } : { t: "group", body };
    }
    if (ch === "[") return { t: "char", set: caseFold(this.charClass()) };
    if (ch === "^" || ch === "$") {
      this.i++;
      return { t: "zero" };
    }
    if (ch === ".") {
      this.i++;
      return { t: "char", set: anySet() };
    }
    if (ch === "\\") {
      const next = p[this.i + 1];
      if (next === "b" || next === "B") {
        this.i += 2;
        return { t: "zero" };
      }
      if (next !== undefined && /[1-9]/.test(next)) throw new Refused("backreferences are not allowed");
      if (next === "k" && p[this.i + 2] === "<") throw new Refused("backreferences are not allowed");
      return { t: "char", set: caseFold(this.escape(false).set) };
    }
    const code = p.codePointAt(this.i)!;
    this.i += code > 0xffff ? 2 : 1;
    return { t: "char", set: caseFold(single(code)) };
  }

  /** Parses the escape at `i` (pointing at the backslash); `code` is set when it stands for one character. */
  private escape(inClass: boolean): { set: CharSet; code?: number } {
    const p = this.p;
    const next = p[this.i + 1];
    this.i += 2;
    const one = (code: number) => (Number.isFinite(code) ? { set: single(code), code } : { set: anySet() });
    switch (next) {
      case "d":
        return { set: DIGIT };
      case "D":
        return { set: complement(DIGIT) };
      case "w":
        return { set: WORD };
      case "W":
        return { set: complement(WORD) };
      case "s":
        return { set: SPACE };
      case "S":
        return { set: complement(SPACE) };
      case "p":
      case "P": {
        if (p[this.i] === "{") {
          const end = p.indexOf("}", this.i);
          this.i = end === -1 ? p.length : end + 1;
        }
        return { set: anySet() };
      }
      case "u": {
        if (p[this.i] === "{") {
          const end = p.indexOf("}", this.i);
          const code = parseInt(p.slice(this.i + 1, end), 16);
          this.i = end === -1 ? p.length : end + 1;
          return one(code);
        }
        const code = parseInt(p.slice(this.i, this.i + 4), 16);
        this.i += 4;
        return one(code);
      }
      case "x": {
        const code = parseInt(p.slice(this.i, this.i + 2), 16);
        this.i += 2;
        return one(code);
      }
      case "c":
        return one(p.charCodeAt(this.i++) % 32);
      case "n":
        return one(10);
      case "r":
        return one(13);
      case "t":
        return one(9);
      case "f":
        return one(12);
      case "v":
        return one(11);
      case "0":
        return one(0);
      case "b":
        return inClass ? one(8) : { set: anySet() };
      case undefined:
        return { set: anySet() };
      default: {
        const code = p.codePointAt(this.i - 1)!;
        if (code > 0xffff) this.i++;
        return one(code);
      }
    }
  }

  private charClass(): CharSet {
    const p = this.p;
    this.i++; // [
    const negate = p[this.i] === "^";
    if (negate) this.i++;
    let s = emptySet();
    while (this.i < p.length && p[this.i] !== "]") {
      const lo = this.classAtom();
      if (p[this.i] === "-" && this.i + 1 < p.length && p[this.i + 1] !== "]") {
        this.i++;
        const hi = this.classAtom();
        if (lo.code !== undefined && hi.code !== undefined) {
          const r = emptySet();
          addRange(r, lo.code, hi.code);
          s = union(s, r);
        } else s = union(union(s, lo.set), hi.set);
      } else s = union(s, lo.set);
    }
    this.i++; // ]
    return negate ? complement(s) : s;
  }

  private classAtom(): { set: CharSet; code?: number } {
    const p = this.p;
    if (p[this.i] === "\\") return this.escape(true);
    const code = p.codePointAt(this.i)!;
    this.i += code > 0xffff ? 2 : 1;
    return { set: single(code), code };
  }
}

/** Refuses repeats whose body can itself match in several ways: those backtrack exponentially. */
function checkStructure(alt: Node[][]) {
  const walk = (n: Node): { unbounded: boolean; ambiguous: boolean } => {
    if (n.t === "char" || n.t === "zero") return { unbounded: false, ambiguous: false };
    if (n.t === "look" || n.t === "group") {
      let unbounded = false;
      let ambiguous = n.body.length > 1;
      for (const seq of n.body)
        for (const m of seq) {
          const r = walk(m);
          unbounded ||= r.unbounded;
          ambiguous ||= r.ambiguous;
        }
      return { unbounded, ambiguous };
    }
    const inner = walk(n.item);
    if (n.max > 1 && inner.unbounded) throw new Refused("nested quantifiers (a repeated group that itself contains * or +) can backtrack catastrophically");
    if (n.max === Infinity && inner.ambiguous) throw new Refused("alternation or optional parts inside a repeated group can backtrack catastrophically");
    return { unbounded: inner.unbounded || n.max === Infinity, ambiguous: inner.ambiguous || n.min !== n.max };
  };
  for (const seq of alt) for (const n of seq) walk(n);
}

interface Cost {
  /** steps to try every way of matching from one position */
  work: number;
  /** distinct ways a match can continue to whatever follows */
  paths: number;
}

/** Characters a node must start with, when it is a single character or a mandatory repeat of one. */
function leadingChar(n: Node): CharSet | undefined {
  if (n.t === "char") return n.set;
  if (n.t === "quant" && n.item.t === "char" && n.min >= 1) return n.item.set;
  return undefined;
}

function geometric(base: number, from: number, to: number): number {
  if (to < from) return 0;
  if (base === 1) return to - from + 1;
  return (Math.pow(base, to + 1) - Math.pow(base, from)) / (base - 1);
}

function altCost(alt: Node[][], L: number): Cost {
  let work = 0;
  let paths = 0;
  for (const seq of alt) {
    const c = seqCost(seq, L);
    work += c.work;
    paths += c.paths;
  }
  return { work, paths: Math.max(paths, 1) };
}

/**
 * Multiplies out the ways each element can match. One exception keeps common patterns like `[a-z]+@[a-z]+`
 * cheap: when a repeated character class is followed by a character it can't match, only the longest run can
 * be followed by it, so the repeat's alternatives collapse back to one.
 */
function seqCost(seq: Node[], L: number): Cost {
  let work = 0;
  let paths = 1;
  let prev: { set: CharSet; ways: number } | undefined;
  for (const n of seq) {
    const lead = leadingChar(n);
    if (prev && lead && disjoint(prev.set, lead)) {
      work += paths; // each way tries the delimiter once
      paths /= prev.ways;
    }
    const c = nodeCost(n, L);
    work += paths * c.work;
    paths *= c.paths;
    if (n.t === "quant" && n.item.t === "char") prev = { set: n.item.set, ways: c.paths };
    else if (n.t !== "zero" && n.t !== "look") prev = undefined;
  }
  return { work, paths };
}

function nodeCost(n: Node, L: number): Cost {
  switch (n.t) {
    case "char":
    case "zero":
      return { work: 1, paths: 1 };
    case "look":
      return { work: altCost(n.body, L).work, paths: 1 };
    case "group":
      return altCost(n.body, L);
    case "quant": {
      const max = Math.min(n.max, L);
      const min = Math.min(n.min, max);
      const inner = nodeCost(n.item, L);
      return {
        work: Math.max(1, geometric(inner.paths, 0, max - 1) * inner.work),
        paths: geometric(inner.paths, min, max),
      };
    }
  }
}

export type RegexFilterAnalysis = { reason: string } | { maxInput: number };

/** Why `pattern` is refused as a word filter, or how many characters of content it may be run on at once. */
export function analyzeRegexFilter(pattern: string): RegexFilterAnalysis {
  const a = analyze(pattern);
  return "reason" in a ? a : { maxInput: a.maxInput };
}

function analyze(pattern: string): { reason: string } | { maxInput: number; steps: (length: number) => number } {
  if (pattern.length > MAX_FILTER_PATTERN_LENGTH) return { reason: `pattern is longer than ${MAX_FILTER_PATTERN_LENGTH} characters` };
  try {
    new RegExp(pattern, "iu");
  } catch (err) {
    return { reason: (err as Error).message };
  }
  let tree: Node[][];
  try {
    tree = new Parser(pattern).parse();
    checkStructure(tree);
  } catch (err) {
    if (err instanceof Refused) return { reason: err.message };
    throw err;
  }
  // every start position may be tried
  const steps = (L: number) => L * altCost(tree, L).work;
  if (!(steps(REGEX_FILTER_MIN_INPUT) <= REGEX_FILTER_STEP_BUDGET)) {
    return { reason: "too many ways to match the same text (it could stall the relay on long posts): use fewer or narrower repeats, or separate repeats with a character they can't match" };
  }
  let lo = REGEX_FILTER_MIN_INPUT;
  let hi = REGEX_FILTER_MAX_INPUT;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (steps(mid) <= REGEX_FILTER_STEP_BUDGET) lo = mid;
    else hi = mid - 1;
  }
  return { maxInput: lo, steps };
}

/** Smallest window the rest of a long post is scanned in. */
const MIN_SCAN_WINDOW = REGEX_FILTER_MIN_INPUT / 2;
/** How far a window edge moves back to land on whitespace. */
const EDGE_SLACK = 32;
/** Real text around an edge match when it is re-checked (enough for \b, anchors and short lookarounds). */
const EDGE_CONTEXT = 64;

/** Whether the pattern can tell where its input starts / ends (anchors, word boundaries, lookarounds). */
function edgeSensitivity(pattern: string): { start: boolean; end: boolean } {
  let start = false;
  let end = false;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      const next = pattern[i + 1];
      if (!inClass && (next === "b" || next === "B")) start = end = true;
      i++;
    } else if (inClass) {
      if (ch === "]") inClass = false;
    } else if (ch === "[") inClass = true;
    else if (ch === "^") start = true;
    else if (ch === "$") end = true;
    else if (ch === "(" && pattern[i + 1] === "?") {
      if (pattern[i + 2] === "=" || pattern[i + 2] === "!") end = true;
      else if (pattern[i + 2] === "<" && (pattern[i + 3] === "=" || pattern[i + 3] === "!")) start = true;
    }
  }
  return { start, end };
}

const isSpace = (c: string, i: number) => /\s/.test(c[i] ?? "");

/**
 * Compiles an acceptable word-filter regex into a case-insensitive content test, or says why it is refused.
 * Content up to the pattern's input limit is tested in one run (its worst case fits the step budget). The rest of a
 * longer post is scanned in overlapping windows for at most one more budget: the largest window size whose scan of
 * the whole post fits is used, so cheap patterns (literals, alternations) cover everything, while backtracking-prone
 * ones stop scanning once the budget is spent. Window edges land on whitespace where possible; where a match touches
 * an inner edge and the pattern has anchors, word boundaries or lookarounds, it only counts once it also matches
 * at the same position with real text around the edge.
 */
export function compileRegexFilter(pattern: string): { reason: string } | { test: (content: string) => boolean } {
  const a = analyze(pattern);
  if ("reason" in a) return a;
  const max = a.maxInput;
  const re = new RegExp(pattern, "iu");
  const scan = new RegExp(pattern, "giu");
  const sticky = new RegExp(pattern, "iuy");
  const sense = edgeSensitivity(pattern);
  // candidate window sizes for the rest of the post, largest first, with their worst-case cost
  const sizes: { w: number; cost: number }[] = [];
  for (let w = max; w >= MIN_SCAN_WINDOW; w = Math.floor(w / 2)) sizes.push({ w, cost: a.steps(w + 2 * EDGE_CONTEXT) });

  /** whether a match at absolute index `at` survives with real text around a window edge */
  const recheck = (c: string, at: number) => {
    const from = Math.max(0, at - EDGE_CONTEXT);
    const slice = c.slice(from, Math.min(c.length, at + EDGE_CONTEXT * 2));
    sticky.lastIndex = at - from;
    const m = sticky.exec(slice);
    return !!m && (from + slice.length === c.length || m.index + m[0].length < slice.length);
  };
  /** a match in c[start, end) that isn't an artefact of cutting the content there */
  const found = (c: string, start: number, end: number) => {
    const slice = c.slice(start, end);
    scan.lastIndex = 0;
    for (let m = scan.exec(slice); m; m = scan.exec(slice)) {
      const at = start + m.index;
      const atStart = start > 0 && m.index === 0;
      const atEnd = end < c.length && m.index + m[0].length >= slice.length;
      if ((!atStart || !sense.start) && (!atEnd || !sense.end)) return true;
      if (recheck(c, at)) return true;
      if (m[0].length === 0) scan.lastIndex++;
    }
    return false;
  };
  /** an index at or a little before `i` just after whitespace, so a cut doesn't split a word */
  const softCut = (c: string, i: number) => {
    for (let j = i - 1; j > i - EDGE_SLACK && j > 0; j--) if (isSpace(c, j)) return j + 1;
    return i;
  };

  const test = (c: string) => {
    if (c.length <= max) return re.test(c);
    const head = softCut(c, max);
    if (found(c, 0, head)) return true;
    const rest = c.length - head;
    const pick = sizes.find(({ w, cost }) => Math.ceil(rest / (w - w / 4)) * cost <= REGEX_FILTER_STEP_BUDGET) ?? sizes[sizes.length - 1];
    const overlap = Math.floor(pick.w / 4);
    let spent = 0;
    for (let start = softCut(c, head - overlap); spent + pick.cost <= REGEX_FILTER_STEP_BUDGET; ) {
      spent += pick.cost;
      const end = start + pick.w >= c.length ? c.length : softCut(c, start + pick.w);
      if (found(c, start, end)) return true;
      if (end >= c.length) return false;
      start = Math.max(softCut(c, end - overlap), start + 1);
    }
    return false;
  };
  return { test };
}

/** Returns why `pattern` is refused as a word filter, or undefined when it is acceptable. */
export function unsafeRegexReason(pattern: string): string | undefined {
  const r = analyzeRegexFilter(pattern);
  return "reason" in r ? r.reason : undefined;
}

/** How many leading characters of the content an acceptable filter pattern may be run on (0 if refused). */
export function regexFilterInputLimit(pattern: string): number {
  const r = analyzeRegexFilter(pattern);
  return "reason" in r ? 0 : r.maxInput;
}
