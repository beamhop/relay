import type { NostrEvent } from "./types";

export interface SearchTerm {
  text: string;
  tokens: string[];
  phrase: boolean;
}

export interface ParsedSearchQuery {
  terms: SearchTerm[];
}

const TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const QUOTED_OR_WORD_RE = /"([^"]+)"|(\S+)/g;
const EXTENSION_KEYS = new Set(["include", "domain", "language", "sentiment", "nsfw", "autocomplete"]);

export function parseSearchQuery(query: string): ParsedSearchQuery {
  const terms: SearchTerm[] = [];
  for (const match of query.matchAll(QUOTED_OR_WORD_RE)) {
    const quoted = match[1];
    const word = match[2];
    if (word && isExtensionToken(word)) continue;

    const text = quoted ?? word ?? "";
    const tokens = tokenizeForSearch(text);
    if (tokens.length === 0) continue;
    terms.push({
      text: tokens.join(" "),
      tokens,
      phrase: quoted !== undefined && tokens.length > 1,
    });
  }
  return { terms };
}

export function searchScore(event: NostrEvent, query: string | ParsedSearchQuery): number {
  const parsed = typeof query === "string" ? parseSearchQuery(query) : query;
  if (parsed.terms.length === 0) return 0;

  const contentText = normalizeSearchText(event.content);
  const tagText = normalizeSearchText(event.tags.flat().join(" "));
  const contentTokens = tokenizeNormalizedText(contentText);
  const tagTokens = tokenizeNormalizedText(tagText);

  let score = 0;
  for (const term of parsed.terms) {
    const termScore = scoreTerm(term, contentText, tagText, contentTokens, tagTokens);
    if (termScore <= 0) return 0;
    score += termScore;
  }
  return score;
}

export function buildSqliteFtsQuery(query: string): string | undefined {
  const parsed = parseSearchQuery(query);
  if (parsed.terms.length === 0) return undefined;

  const expressions = parsed.terms.map((term) => {
    if (term.phrase) return `"${escapeFtsToken(term.text)}"`;
    return term.tokens.map(ftsTokenExpression).join(" AND ");
  });
  return expressions.filter(Boolean).join(" AND ");
}

export function eventSearchFields(event: NostrEvent): { content: string; tags: string } {
  return {
    content: event.content,
    tags: event.tags.flat().join(" "),
  };
}

export class MemorySearchIndex {
  private readonly postings = new Map<string, Set<string>>();

  clear(): void {
    this.postings.clear();
  }

  add(event: NostrEvent): void {
    for (const token of eventSearchTokens(event)) {
      let ids = this.postings.get(token);
      if (!ids) {
        ids = new Set();
        this.postings.set(token, ids);
      }
      ids.add(event.id);
    }
  }

  delete(event: NostrEvent): void {
    for (const token of eventSearchTokens(event)) {
      const ids = this.postings.get(token);
      if (!ids) continue;
      ids.delete(event.id);
      if (ids.size === 0) this.postings.delete(token);
    }
  }

  searchIds(query: string): Set<string> {
    const parsed = parseSearchQuery(query);
    if (parsed.terms.length === 0) return new Set();

    let result: Set<string> | undefined;
    for (const term of parsed.terms) {
      const termIds = this.idsForTerm(term);
      result = result ? intersectSets(result, termIds) : termIds;
      if (result.size === 0) break;
    }
    return result ?? new Set();
  }

  private idsForTerm(term: SearchTerm): Set<string> {
    let result: Set<string> | undefined;
    for (const token of term.tokens) {
      const tokenIds = this.idsForToken(token);
      result = result ? intersectSets(result, tokenIds) : tokenIds;
      if (result.size === 0) break;
    }
    return result ?? new Set();
  }

  private idsForToken(token: string): Set<string> {
    const exact = this.postings.get(token);
    const result = new Set(exact ?? []);
    if (token.length < 3) return result;

    for (const [indexedToken, ids] of this.postings) {
      if (indexedToken === token || !indexedToken.startsWith(token)) continue;
      for (const id of ids) result.add(id);
    }
    return result;
  }
}

function scoreTerm(term: SearchTerm, contentText: string, tagText: string, contentTokens: string[], tagTokens: string[]): number {
  if (term.phrase) {
    let score = 0;
    if (contentText.includes(term.text)) score += 40;
    if (tagText.includes(term.text)) score += 8;
    return score;
  }

  let score = 0;
  for (const token of term.tokens) {
    score += scoreToken(token, contentTokens, 8, 4);
    score += scoreToken(token, tagTokens, 2, 1);
  }
  return score;
}

function scoreToken(queryToken: string, tokens: string[], exactWeight: number, prefixWeight: number): number {
  let score = 0;
  for (const token of tokens) {
    if (token === queryToken) score += exactWeight;
    else if (queryToken.length >= 3 && token.startsWith(queryToken)) score += prefixWeight;
  }
  return score;
}

function eventSearchTokens(event: NostrEvent): Set<string> {
  const fields = eventSearchFields(event);
  return new Set([...tokenizeForSearch(fields.content), ...tokenizeForSearch(fields.tags)]);
}

function tokenizeForSearch(text: string): string[] {
  return tokenizeNormalizedText(normalizeSearchText(text));
}

function tokenizeNormalizedText(text: string): string[] {
  return [...text.matchAll(TOKEN_RE)].map((match) => match[0] as string);
}

function normalizeSearchText(text: string): string {
  return text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function ftsTokenExpression(token: string): string {
  const escaped = escapeFtsToken(token);
  return token.length >= 3 ? `"${escaped}"*` : `"${escaped}"`;
}

function escapeFtsToken(token: string): string {
  return token.replace(/"/g, "\"\"");
}

function isExtensionToken(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  return EXTENSION_KEYS.has(value.slice(0, separator).toLowerCase());
}

function intersectSets(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of smaller) {
    if (larger.has(value)) result.add(value);
  }
  return result;
}
