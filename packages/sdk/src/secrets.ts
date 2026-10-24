/**
 * One matcher for "does this settings key / value hold a credential?", shared by the admin API (masking plugin
 * settings for viewers) and the server (redacting plugin settings in audit records and logs). It errs towards
 * masking: hiding a harmless value from a viewer is cheap, showing a secret is not.
 */

/** Splits `secretAccessKey` / `api_key` / `S3-SECRET` / `apiKeyV2` into lower-case words, digit suffixes dropped. */
function keyWords(key: string): string[] {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // `apiKeyV2`, `token_v3` → drop a trailing version word; `apiKey2`, `password2` → drop trailing digits
  if (words.length > 1 && /^v\d+$/.test(words[words.length - 1])) words.pop();
  return words.map((w) => w.replace(/\d+$/, "")).filter(Boolean);
}

/** Substrings that name a credential wherever they appear in the joined key (`relayNsecHex`, `smtpPassword`). */
const SECRET_SUBSTRINGS = ["secret", "passw", "passphrase", "passcode", "pwd", "nsec", "mnemonic", "credential", "authorization", "apikey", "accesskey", "authtoken", "authheader", "basicauth", "privkey", "privatekey", "recoveryphrase", "recoverycode", "backupcode", "connectionstring", "webhook"];
/** Whole words that name a credential on their own. */
const SECRET_WORDS = new Set(["priv", "pem", "dsn", "pin", "sk", "cookie", "bearer", "nwc", "jwt", "otp", "totp", "hmac", "salt", "pepper", "pat"]);
/** Words after a secret word that describe it rather than hold it (`cookieName`, `cookieSameSite`). */
const SECRET_WORD_META = new Set(["name", "domain", "path", "same", "secure", "http", "prefix", "relay", "relays"]);
/** Words after `key` that describe the key rather than hold it (`keyName`, `apiKeyHeader`, `keyPath`). */
const KEY_META_NEXT = new Set(["name", "type", "format", "algorithm", "algo", "path", "prefix", "header", "headers", "field", "param", "location", "id", "size", "length", "bits"]);
/** Last words naming a list of public relay URLs (`nwcRelays`, `nsecbunkerRelay`). */
const RELAY_LIST = new Set(["relay", "relays"]);
/** Words after `token` that make it a count or a rate (`tokenBucketSize`, `tokensPerMinute`), not a credential. */
const TOKEN_COUNTISH = new Set(["bucket", "buckets", "limit", "limits", "count", "counts", "size", "rate", "budget", "cost", "cap", "per", "window", "refill"]);
/** Words before `tokens` that make it a count (`maxTokens`). */
const TOKENS_COUNTISH_BEFORE = new Set(["max", "min", "num", "total", "limit", "per", "count", "used", "remaining"]);
/** Words after `seed` that make it a bootstrap list rather than a wallet seed (`seedRelays`). */
const SEED_NOT_SECRET = new Set(["relay", "relays", "node", "nodes", "peer", "peers", "url", "urls", "host", "hosts"]);
/** Qualifiers that make a `…key` harmless (`publicKey`, `relayPubkey`, `sortKey`, `cacheKey`). */
const SAFE_KEY_QUALIFIERS = new Set(["public", "pub", "npub", "max", "min", "cache", "sort", "primary", "foreign", "idempotency", "partition", "lookup", "group", "row", "map", "dedupe", "unique", "hot", "shortcut", "short", "object", "storage", "bucket", "routing", "event", "allowed", "trusted", "whitelist", "allowlist", "blocked", "banned", "blocklist", "denylist"]);

/** Last words that describe a credential's policy rather than hold one (`passwordMinLength`, `tokenTtl`). */
const META_SUFFIXES = new Set(["min", "max", "length", "len", "minlength", "maxlength", "policy", "rules", "strength", "required", "enabled", "count", "attempts", "ttl", "expiry", "lifetime", "timeout", "interval", "rounds", "iterations", "hint"]);
/** Ordinary words that happen to end in "key". */
const NOT_KEY_WORDS = new Set(["monkey", "donkey", "turkey", "hockey", "jockey", "whiskey", "turnkey"]);

/** The `…key` part of a word: `pubkey` → "pub", `apikey` → "api", `key` → "". Undefined when the word isn't one. */
const keyQualifier = (word: string): string | undefined => {
  const m = /^(.*?)keys?$/.exec(word);
  return m ? m[1] : undefined;
};

export function isSecretKeyName(key: string): boolean {
  const words = keyWords(key);
  if (!words.length) return false;
  if (words.length > 1 && META_SUFFIXES.has(words[words.length - 1])) return false;
  const joined = words.join("");
  if (words.length > 1 && RELAY_LIST.has(words[words.length - 1])) return false;
  // `apiKeyHeader`, `secretKeyPath`, `privateKeyFormat`: the setting describes a key rather than holding one
  for (let i = 0; i < words.length - 1; i++) {
    if (keyQualifier(words[i]) !== undefined && !NOT_KEY_WORDS.has(words[i]) && KEY_META_NEXT.has(words[i + 1])) return false;
  }
  if (SECRET_SUBSTRINGS.some((s) => joined.includes(s))) return true;
  if (joined === "auth" || joined === "pass") return true;
  if (words[words.length - 1] === "pass") return true;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const next = words[i + 1];
    const prev = words[i - 1];
    if (SECRET_WORDS.has(w) && !(next && SECRET_WORD_META.has(next))) return true;
    if (w === "token" || (w.endsWith("token") && w.length > 5 && i === words.length - 1)) {
      if (!next || !TOKEN_COUNTISH.has(next)) return true;
    }
    if (w === "tokens" && !(prev && TOKENS_COUNTISH_BEFORE.has(prev)) && !(next && TOKEN_COUNTISH.has(next))) return true;
    if ((w === "seed" || w === "seeds") && !(next && SEED_NOT_SECRET.has(next))) return true;
    // `…key` / `…keys`: `apiKey`, `hmacKey`, `openaikey`, a bare `key` — unless a safe qualifier says otherwise
    const q = NOT_KEY_WORDS.has(w) ? undefined : keyQualifier(w);
    if (q !== undefined) {
      const qualifier = q || prev || "";
      if (!SAFE_KEY_QUALIFIERS.has(qualifier) && !(next && KEY_META_NEXT.has(next))) return true;
    }
  }
  return false;
}

/** Query or `;`-separated parameters whose name ends in a credential word (`client_secret`, `X-Amz-Signature`, `api-key`). */
const SECRET_PARAM = /(?:^|[?&;#])\s*[\w.-]*?(?:secret|token|key|passw(?:or)?d|pwd|pass|signature|sig|credentials?|auth)\s*=/i;
/** Values that are credentials by shape: PEM private keys, bearer/basic auth, webhook and bot URLs, well-known token prefixes. */
const SECRET_SHAPES = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /^\s*bearer\s+\S{8,}/i,
  /^\s*basic\s+[A-Za-z0-9+/=]{8,}\s*$/i,
  /hooks\.slack\.com\/(?:services|workflows|triggers)\//i,
  /discord(?:app)?\.com\/api\/webhooks\//i,
  /\/bot\d{5,}:[\w-]{20,}/,
  /\bxox[abprs]-[\w-]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/,
];
/** A bech32 Nostr secret key. */
const NSEC = /\bnsec1[02-9ac-hj-np-z]{20,}\b/i;

/**
 * String values that carry a credential whatever their key is called: URLs with `user:pass@`, NWC / bunker URIs
 * and other URLs or connection strings with credential-named parameters, nsec keys, PEM private keys,
 * bearer/basic auth values and Slack/Discord/Telegram webhook URLs.
 */
export function looksLikeSecretValue(v: string): boolean {
  if (NSEC.test(v)) return true;
  if (/^(nostr\+walletconnect|bunker):\/\//i.test(v) && /secret=/i.test(v)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(v)) return true;
  if (SECRET_SHAPES.some((re) => re.test(v))) return true;
  return SECRET_PARAM.test(v);
}
