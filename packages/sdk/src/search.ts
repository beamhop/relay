/**
 * NIP-50 search string tokenization, shared by the stores (stored queries) and the relay (live delivery) so both
 * pick the same terms out of a query. What a term then matches still differs: see `searchTerms`.
 */

const EXTENSION_TOKEN = /^[a-zA-Z_-]+:[^/\s]/;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Splits a NIP-50 search string into plain terms / quoted phrases, dropping `key:value`
 * extensions (domain:, language:, include:spam, …) and tokens without any word characters.
 */
export function parseSearch(search: string): { terms: string[]; phrases: boolean[] } {
  const terms: string[] = [];
  const phrases: boolean[] = [];
  // NUL: postgres can't bind it, and stored content never contains it
  for (const tok of search.replace(/\u0000/g, "").match(/"[^"]*"|\S+/g) ?? []) {
    const quoted = tok.length >= 2 && tok.startsWith('"') && tok.endsWith('"');
    if (!quoted && EXTENSION_TOKEN.test(tok)) continue;
    const text = (quoted ? tok.slice(1, -1) : tok).replace(/"/g, " ").trim();
    if (!text || !HAS_WORD_CHAR.test(text)) continue;
    terms.push(text);
    phrases.push(quoted);
  }
  return { terms, phrases };
}

/**
 * The search terms lowercased, for live matching as substrings of the lowercased content. This is not what the
 * stores do: SQLite matches whole FTS5 tokens with diacritics folded (prefix on the last term) and Postgres runs
 * websearch_to_tsquery('simple') against its tsvector, so live delivery and a stored query can disagree on word
 * boundaries ("art" is in "party" live, not stored) and accents.
 */
export const searchTerms = (search: string): string[] => parseSearch(search).terms.map((t) => t.toLowerCase());
