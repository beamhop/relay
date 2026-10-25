import { SOFT_BUFFER_LIMIT } from "./connection";

/** Max items in a negentropy session before refusing with NEG-ERR. */
export const MAX_NEG_ITEMS = 500_000;
/** Ids listed per query while preparing a negentropy session. */
export const NEG_ID_PAGE = 50_000;
/** Negentropy frame size limit (bytes before hex encoding). */
export const NEG_FRAME_SIZE_LIMIT = 60_000;
/** Negentropy sessions open longer than this are dropped (idle ones sooner, see NEG_IDLE_TIMEOUT_MS). */
export const NEG_SESSION_TTL_MS = 5 * 60_000;
/** Negentropy sessions (open or being prepared) per connection. */
export const MAX_NEG_SESSIONS_PER_CONN = 2;
/** Items held by all open negentropy sessions and listed by NEG-OPENs being prepared, together (~72 bytes each). */
export const NEG_GLOBAL_ITEM_BUDGET = 2_000_000;
/** NEG-OPENs being prepared at once, relay-wide (each may load up to MAX_NEG_ITEMS ids). */
export const NEG_OPEN_CONCURRENCY = 4;
/** NEG-MSG payload (hex chars) per connection per minute; per address it's IP_RATE_FACTOR times that. */
export const NEG_MSG_HEX_PER_MINUTE = 32 << 20;
/** Max sync candidates checked one by one against visibility rules (plugin hooks, many private events). */
export const MAX_VISIBILITY_SCAN = 50_000;
/** Sum of filterWeight() over a connection's open subscriptions. */
export const MAX_FILTER_WEIGHT_PER_CONN = 20_000;
/** EVENTs a connection may have awaiting their OK. */
export const MAX_INFLIGHT_EVENTS = 100;
/** The same for staff, allow-listed IPs and users with a rate-limit override (bridges, importers). */
export const MAX_INFLIGHT_EVENTS_TRUSTED = 1_000;
/**
 * Inbound messages per connection per minute (one-minute burst), checked before any expensive work
 * (signature verification, queries). Per address the limit is MESSAGE_IP_FACTOR times that. CLOSE and
 * NEG-CLOSE are exempt, as are relay staff and allow-listed IPs; users with a rate-limit override get
 * a higher per-connection limit and no per-address bucket (their own limits apply).
 */
export const MESSAGES_PER_MINUTE = 1200;
export const MESSAGE_IP_FACTOR = 4;
/** Pubkeys one connection may authenticate as (NIP-42). */
export const MAX_AUTHED_PUBKEYS = 10;
export const AUTH_PER_MINUTE = 30;
/**
 * Stored results are paced to keep the client's send buffer below half of SOFT_BUFFER_LIMIT (where live
 * delivery starts dropping events), so a backfill doesn't crowd out live events on other subscriptions.
 * A client that doesn't drain within drainTimeoutMs is disconnected.
 */
export const BACKPRESSURE = { drainTimeoutMs: 10_000, pollMs: 25, highWater: SOFT_BUFFER_LIMIT / 2 };
/** Interval of the relay-wide sweep of expired negentropy sessions. */
export const NEG_SWEEP_MS = 30_000;
/** NEG-OPENs being prepared at once per client address; more wait briefly for a slot (NEG_OPEN_WAIT_MS). */
export const NEG_OPEN_PER_IP = 2;
export const NEG_OPEN_WAIT_MS = 3_000;
/** Max live events buffered while a stored query is in flight. */
export const MAX_PENDING_LIVE = 1000;
export const VISIBILITY_BATCH = 500;
/** Bytes of events (at maxEventBytes each) loaded at once for visibility checks. */
export const VISIBILITY_BATCH_BYTES = 4 << 20;
/**
 * Rows a REQ may load beyond its filters' first pages, to refill limits taken by events the connection
 * can't see (see streamStored).
 */
export const MAX_REFILL_SCAN = 5_000;
/** Smallest refill page: a few hidden events shouldn't cost a query per missing result. */
export const REFILL_MIN_PAGE = 20;
/** Queries per search filter while raising its limit past hidden results (search can't be paged). */
export const SEARCH_REFILL_ROUNDS = 4;
/** Max potentially-private events inspected per COUNT / NEG-OPEN before refusing the filter as too broad. */
export const MAX_PRIVATE_SCAN = 5_000;
/** Max search matches checked one by one for a COUNT under plugin visibility hooks (search can't list ids cheaply). */
export const MAX_SEARCH_COUNT_SCAN = 1_000;
/** Sessions idle longer than this are closed (NIP-77 lets relays time out inactive sessions). */
export const NEG_IDLE_TIMEOUT_MS = 60_000;

/**
 * Rate-limit buckets kept per connection, keyed `<bucket>:conn:<connection id>` (connBucket). The relay
 * deletes all of them when the connection closes.
 */
export const CONN_RATE_BUCKETS = ["req", "search", "msg", "auth", "neg"] as const;
export type ConnRateBucket = (typeof CONN_RATE_BUCKETS)[number];

/** Key of a per-connection rate-limit bucket (one of CONN_RATE_BUCKETS). */
export const connBucket = (bucket: ConnRateBucket, connId: string): string => `${bucket}:conn:${connId}`;
