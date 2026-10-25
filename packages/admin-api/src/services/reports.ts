import type { AdminApiDeps, BlobRecord, NostrEvent, Paged, ReportStatus, ReportView, ResolveReportRequest } from "@beamhop/sdk";
import { chunk, placeholders } from "../db";
import { badRequest, notFound } from "../errors";
import type { ModerationService } from "./moderation";
import type { ProfileService } from "./profiles";
import type { Actor, UserService } from "./users";

const REPORT_KIND = 1984;
/** report types are short NIP-56 words; longer values (reporter-controlled) are cut */
export const MAX_REPORT_TYPE = 32;
/** reports read per page while backfilling the index from the event store */
const BACKFILL_PAGE = 1000;
/** most reports of one second the backfill loads when more than a page share it */
const BACKFILL_SECOND_CAP = 100_000;
/** reports newer than the index that a read picks up (see catchUp) */
const CATCH_UP_LIMIT = 500;
/** kv flag (namespace admin) set once the index holds every stored report */
const BACKFILL_FLAG = "report_index_backfilled";
/** minimum time between two sweeps for index rows whose report is gone */
const SWEEP_GAP_MS = 60_000;
const SWEEP_PAGE = 500;

export interface ParsedReport {
  targetPubkey: string;
  targetEventId?: string;
  targetBlob?: string;
  type: string;
}
export interface StatusRow {
  status: ReportStatus;
  action: string;
  by: string;
  at: number;
  note: string | null;
}
type Subject = { pubkey: string; claimed?: string };

function parseReport(ev: NostrEvent): ParsedReport {
  const p = ev.tags.find((t) => t[0] === "p" && t[1]);
  const e = ev.tags.find((t) => t[0] === "e" && t[1]);
  const x = ev.tags.find((t) => t[0] === "x" && t[1]);
  const type = (e?.[2] || x?.[2] || p?.[2] || "other").slice(0, MAX_REPORT_TYPE).toLowerCase();
  return { targetPubkey: p?.[1] ?? "", targetEventId: e?.[1], targetBlob: x?.[1], type };
}

/**
 * Who a report is about. The `p` tag is only the reporter's claim: when the reported event is stored its author is
 * the subject (and for a stored blob, one of its uploaders), so a report pairing someone's content with another
 * pubkey can't steer a ban onto that pubkey. Without stored content to check against, the `p` tag stands.
 */
function subjectOf(p: ParsedReport, eventAuthor?: string, blob?: BlobRecord): Subject {
  let pubkey = p.targetPubkey;
  if (eventAuthor) pubkey = eventAuthor;
  else if (blob?.owners.length && !blob.owners.includes(pubkey)) pubkey = blob.owners.length === 1 ? blob.owners[0] : "";
  return p.targetPubkey && p.targetPubkey !== pubkey ? { pubkey, claimed: p.targetPubkey } : { pubkey };
}

const targetKey = (r: ParsedReport) =>
  r.targetEventId ? `e:${r.targetEventId}` : r.targetBlob ? `x:${r.targetBlob}` : `p:${r.targetPubkey}`;

/**
 * Work already done by earlier items of one bulk resolution: a subject is rank-checked and banned once, a target event
 * or blob deleted once, however many of the selected reports point at it.
 */
export interface ResolveMemo {
  checked: Map<string, Promise<void>>;
  banned: Set<string>;
  deletedEvents: Set<string>;
  deletedBlobs: Set<string>;
}
export const newResolveMemo = (): ResolveMemo => ({ checked: new Map(), banned: new Set(), deletedEvents: new Set(), deletedBlobs: new Set() });

/**
 * Reports (NIP-56 kind 1984 events, stored like any other) and their moderation state. Listing, filters, counts and
 * paging run on `admin_report_index`, one row per stored report with what the queue filters on (type, target, subject,
 * status). It is kept up to date from bus "report.created" and status changes, backfilled once from the event store, and
 * picks up reports stored without that bus event (catchUp). Reports deleted from the event store (NIP-09, vanish, user
 * deletion) leave rows behind: reads skip and drop them, and bulk deletions trigger a sweep.
 */
export class ReportService {
  private catching: Promise<void> | null = null;
  private lastSweep = 0;
  private sweeping: Promise<void> | null = null;

  constructor(
    private readonly deps: AdminApiDeps,
    private readonly profiles: ProfileService,
    private readonly users: UserService,
    private readonly moderation: ModerationService,
    private readonly nowSec: () => number,
  ) {}

  private get db() {
    return this.deps.stores.db;
  }

  // ---------------------------------------------------------------- index maintenance

  /** Adds reports to the index (already indexed ones are left alone), with their status and current subject. */
  async index(events: NostrEvent[]): Promise<void> {
    const reports = events.filter((e) => e.kind === REPORT_KIND);
    if (!reports.length) return;
    const parsed = reports.map(parseReport);
    const subjects = await this.subjects(parsed);
    await this.db.tx(async (db) => {
      for (let i = 0; i < reports.length; i++) {
        const ev = reports[i];
        const p = parsed[i];
        await db.run(
          `INSERT INTO admin_report_index (id, created_at, reporter, type, target_key, target_event, target_blob, subject_pubkey, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT status FROM admin_report_status WHERE report_id = ?), 'open'))
           ON CONFLICT (id) DO NOTHING`,
          [ev.id, ev.created_at, ev.pubkey, p.type, targetKey(p), p.targetEventId ?? null, p.targetBlob ?? null, subjects[i].pubkey, ev.id],
        );
      }
    });
  }

  /** Drops index rows (their reports are gone from the event store). */
  async forget(ids: string[]): Promise<void> {
    for (const part of chunk([...new Set(ids)])) {
      if (part.length) await this.db.run(`DELETE FROM admin_report_index WHERE id IN (${placeholders(part.length)})`, part);
    }
  }

  /**
   * One-time fill of the index from the reports already stored (newest first, page by page). Runs at startup until it
   * completes once; re-running is harmless (rows already indexed are skipped).
   */
  async backfill(): Promise<number> {
    const { kv, events } = this.deps.stores;
    if (await kv.get<boolean>("admin", BACKFILL_FLAG)) return 0;
    let n = 0;
    let until: number | undefined;
    for (;;) {
      const page = await events.query([{ kinds: [REPORT_KIND], limit: BACKFILL_PAGE, ...(until !== undefined ? { until } : {}) }], { maxLimit: BACKFILL_PAGE });
      await this.index(page);
      n += page.length;
      if (page.length < BACKFILL_PAGE) break;
      const last = page[page.length - 1].created_at;
      if (page[0].created_at === last) {
        // a whole page shares one second: load that second at once, then step past it
        const second = await events.query([{ kinds: [REPORT_KIND], since: last, until: last, limit: BACKFILL_SECOND_CAP }], { maxLimit: BACKFILL_SECOND_CAP });
        if (second.length >= BACKFILL_SECOND_CAP) this.deps.logger.warn("report index backfill: more reports share one second than can be loaded", { created_at: last });
        await this.index(second);
        until = last - 1;
      } else until = last; // the last second again (the store can't page within it); indexed rows are skipped
      if (until < 0) break;
    }
    await kv.set("admin", BACKFILL_FLAG, true);
    if (n) this.deps.logger.info("report index backfilled", { reports: n });
    return n;
  }

  /**
   * Indexes reports stored without a "report.created" bus event (direct store writes: policy-bypassing imports,
   * plugins), as long as they are not older than the newest indexed one. Single-flight; failures only log.
   */
  private catchUp(): Promise<void> {
    if (!this.catching) {
      this.catching = (async () => {
        const row = await this.db.get<{ t: number | string | null }>("SELECT MAX(created_at) AS t FROM admin_report_index");
        const since = row?.t === null || row?.t === undefined ? undefined : Number(row.t);
        const recent = await this.deps.stores.events.query([{ kinds: [REPORT_KIND], limit: CATCH_UP_LIMIT, ...(since !== undefined ? { since } : {}) }], {
          maxLimit: CATCH_UP_LIMIT,
        });
        if (!recent.length) return;
        const known = new Set<string>();
        for (const part of chunk(recent.map((e) => e.id))) {
          for (const r of await this.db.all<{ id: string }>(`SELECT id FROM admin_report_index WHERE id IN (${placeholders(part.length)})`, part)) known.add(r.id);
        }
        await this.index(recent.filter((e) => !known.has(e.id)));
      })()
        .catch((err) => this.deps.logger.warn("report index catch-up failed", { error: String(err) }))
        .finally(() => (this.catching = null));
    }
    return this.catching;
  }

  /**
   * Drops the rows of reports no longer stored (after a vanish request, a user deletion, retention…), page by page.
   * At most one at a time and one per SWEEP_GAP_MS; `force` skips the gap.
   */
  sweep(force = false): Promise<void> {
    if (this.sweeping) return this.sweeping;
    const now = Date.now();
    if (!force && now - this.lastSweep < SWEEP_GAP_MS) return Promise.resolve();
    this.lastSweep = now;
    this.sweeping = (async () => {
      let after = "";
      for (;;) {
        const ids = (await this.db.all<{ id: string }>("SELECT id FROM admin_report_index WHERE id > ? ORDER BY id LIMIT ?", [after, SWEEP_PAGE])).map((r) => r.id);
        if (!ids.length) return;
        const stored = await this.load(ids);
        await this.forget(ids.filter((id) => !stored.has(id)));
        if (ids.length < SWEEP_PAGE) return;
        after = ids[ids.length - 1];
      }
    })()
      .catch((err) => this.deps.logger.warn("report index sweep failed", { error: String(err) }))
      .finally(() => (this.sweeping = null));
    return this.sweeping;
  }

  /** Stored report events by id (reports deleted from the event store are absent). */
  private async load(ids: string[]): Promise<Map<string, NostrEvent>> {
    const out = new Map<string, NostrEvent>();
    for (const part of chunk([...new Set(ids)])) {
      if (!part.length) continue;
      for (const ev of await this.deps.stores.events.query([{ ids: part, kinds: [REPORT_KIND], limit: part.length }], { maxLimit: part.length })) out.set(ev.id, ev);
    }
    return out;
  }

  // ---------------------------------------------------------------- status

  async statuses(ids: string[]): Promise<Map<string, StatusRow>> {
    const out = new Map<string, StatusRow>();
    for (const part of chunk([...new Set(ids)])) {
      if (!part.length) continue;
      const rows = await this.db.all<{ report_id: string } & StatusRow>(
        `SELECT report_id, status, action, by, at, note FROM admin_report_status WHERE report_id IN (${placeholders(part.length)})`,
        part,
      );
      for (const r of rows) out.set(r.report_id, { status: r.status, action: r.action, by: r.by, at: Number(r.at), note: r.note });
    }
    return out;
  }

  async setStatus(id: string, status: ReportStatus, action: string, by: string, note?: string | null): Promise<void> {
    await this.db.tx(async (db) => {
      await db.run(
        `INSERT INTO admin_report_status (report_id, status, action, by, at, note) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (report_id) DO UPDATE SET status = excluded.status, action = excluded.action, by = excluded.by, at = excluded.at, note = excluded.note`,
        [id, status, action, by, this.nowSec(), note ?? null],
      );
      await db.run("UPDATE admin_report_index SET status = ? WHERE id = ?", [status, id]);
    });
  }

  /** Ids of the open reports whose reported event is `eventId` (NIP-86 allowevent / banevent). */
  async openFor(eventId: string): Promise<string[]> {
    await this.catchUp();
    const rows = await this.db.all<{ id: string }>("SELECT id FROM admin_report_index WHERE target_event = ? AND status = 'open'", [eventId]);
    return rows.map((r) => r.id);
  }

  /** Sets the status of every open report of `eventId`; returns how many. */
  async resolveFor(eventId: string, status: ReportStatus, action: string, by: string, note?: string | null): Promise<number> {
    const ids = await this.openFor(eventId);
    for (const id of ids) await this.setStatus(id, status, action, by, note);
    return ids.length;
  }

  // ---------------------------------------------------------------- reads

  /**
   * `target`: a reported event id or blob hash, or a pubkey matched against each report's subject — the view's
   * `targetPubkey` (the stored content's author / uploader, else the `p` tag), not the `p` tag alone.
   */
  async list(q: { status?: ReportStatus; type?: string; target?: string; limit: number; offset: number }): Promise<Paged<ReportView>> {
    await this.catchUp();
    const conds: string[] = [];
    const params: unknown[] = [];
    const cond = (sql: string, ...values: unknown[]) => {
      conds.push(sql);
      params.push(...values);
    };
    if (q.status) cond("status = ?", q.status);
    if (q.type) cond("type = ?", q.type);
    if (q.target) {
      const t = q.target;
      if (/^[0-9a-f]{64}$/.test(t)) cond("(target_event = ? OR target_blob = ? OR subject_pubkey = ?)", t, t, t);
      else cond("(target_event = ? OR target_blob = ?)", t, t);
    }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    // rows of reports deleted from the event store are dropped as they turn up, then the page is read again
    for (let attempt = 0; ; attempt++) {
      const count = await this.db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM admin_report_index${where}`, params);
      const rows = await this.db.all<{ id: string; subject_pubkey: string }>(
        `SELECT id, subject_pubkey FROM admin_report_index${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
        [...params, q.limit, q.offset],
      );
      const events = await this.load(rows.map((r) => r.id));
      const missing = rows.filter((r) => !events.has(r.id)).map((r) => r.id);
      if (missing.length) {
        await this.forget(missing);
        if (attempt < 2) continue;
      }
      const page = rows.flatMap((r) => events.get(r.id) ?? []);
      const items = await this.views(page);
      await this.refreshSubjects(rows, items);
      return { items, total: Math.max(0, Number(count?.n ?? 0) - missing.length) };
    }
  }

  /**
   * The subject recorded when a report was indexed can change: its reported event may arrive (or be deleted) later. Rows
   * shown are corrected from the views just built, so the `target` filter follows.
   */
  private async refreshSubjects(rows: { id: string; subject_pubkey: string }[], views: ReportView[]): Promise<void> {
    const indexed = new Map(rows.map((r) => [r.id, r.subject_pubkey]));
    for (const v of views) {
      if (indexed.get(v.id) !== v.targetPubkey) await this.db.run("UPDATE admin_report_index SET subject_pubkey = ? WHERE id = ?", [v.targetPubkey, v.id]);
    }
  }

  /** Open reports, newest first, that name an event (for NIP-86 listeventsneedingmoderation). */
  async open(limit = 1000): Promise<{ event: NostrEvent; parsed: ParsedReport }[]> {
    await this.catchUp();
    const rows = await this.db.all<{ id: string }>(
      "SELECT id FROM admin_report_index WHERE status = 'open' AND target_event IS NOT NULL ORDER BY created_at DESC, id ASC LIMIT ?",
      [limit],
    );
    const events = await this.load(rows.map((r) => r.id));
    const missing = rows.filter((r) => !events.has(r.id)).map((r) => r.id);
    if (missing.length) await this.forget(missing);
    return rows.flatMap((r) => {
      const event = events.get(r.id);
      return event ? [{ event, parsed: parseReport(event) }] : [];
    });
  }

  /** Reports per reported event among `ids` (any status), for event views. */
  async countsForEvents(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    await this.catchUp();
    for (const part of chunk([...new Set(ids)])) {
      if (!part.length) continue;
      const rows = await this.db.all<{ target_event: string; n: number | string }>(
        `SELECT target_event, COUNT(*) AS n FROM admin_report_index WHERE target_event IN (${placeholders(part.length)}) GROUP BY target_event`,
        part,
      );
      for (const r of rows) out.set(r.target_event, Number(r.n));
    }
    return out;
  }

  async get(id: string): Promise<ReportView | undefined> {
    const ev = await this.deps.stores.events.getById(id);
    if (!ev || ev.kind !== REPORT_KIND) return undefined;
    return (await this.views([ev]))[0];
  }

  /** `related: false` skips `relatedCount` (it is then 0) */
  async view(ev: NostrEvent, opts: { related?: boolean } = {}): Promise<ReportView> {
    return (await this.views([ev], undefined, opts))[0];
  }

  async views(events: NostrEvent[], known?: Map<string, StatusRow>, opts: { related?: boolean } = {}): Promise<ReportView[]> {
    if (!events.length) return [];
    const statuses = known ?? (await this.statuses(events.map((e) => e.id)));
    const parsed = events.map(parseReport);
    const targetIds = [...new Set(parsed.map((p) => p.targetEventId).filter((x): x is string => !!x))];
    const targets = new Map<string, NostrEvent>();
    if (targetIds.length) {
      for (const ev of await this.deps.stores.events.query([{ ids: targetIds }], { maxLimit: targetIds.length })) targets.set(ev.id, ev);
    }
    const blobs = await this.blobs(parsed.map((p) => p.targetBlob));
    const subjects = parsed.map((p) =>
      subjectOf(p, p.targetEventId ? targets.get(p.targetEventId)?.pubkey : undefined, p.targetBlob ? blobs.get(p.targetBlob) : undefined),
    );
    const profiles = await this.profiles.getMany([...events.map((e) => e.pubkey), ...subjects.flatMap((s) => [s.pubkey, s.claimed ?? ""])]);
    const related = opts.related === false ? new Map<string, number>() : await this.relatedCounts(parsed);
    return events.map((ev, i) => {
      const p = parsed[i];
      const s = subjects[i];
      const st = statuses.get(ev.id);
      const view: ReportView = {
        id: ev.id,
        report: ev,
        reporter: ev.pubkey,
        reporterProfile: profiles.get(ev.pubkey),
        targetPubkey: s.pubkey,
        targetProfile: profiles.get(s.pubkey),
        targetEventId: p.targetEventId,
        targetEvent: p.targetEventId ? targets.get(p.targetEventId) : undefined,
        targetBlob: p.targetBlob,
        type: p.type,
        status: st?.status ?? "open",
        relatedCount: related.get(targetKey(p)) ?? 0,
      };
      if (s.claimed) {
        view.claimedPubkey = s.claimed;
        view.claimedProfile = profiles.get(s.claimed);
      }
      if (st) view.resolution = { action: st.action, by: st.by, at: st.at, ...(st.note ? { note: st.note } : {}) };
      return view;
    });
  }

  /** Subjects of reports, with one lookup for their stored target events and one per distinct blob. */
  private async subjects(parsed: ParsedReport[]): Promise<Subject[]> {
    const ids = [...new Set(parsed.map((p) => p.targetEventId).filter((x): x is string => !!x))];
    const authors = new Map<string, string>();
    for (const part of chunk(ids)) {
      for (const ev of await this.deps.stores.events.query([{ ids: part, limit: part.length }], { maxLimit: part.length })) authors.set(ev.id, ev.pubkey);
    }
    const blobs = await this.blobs(parsed.filter((p) => !(p.targetEventId && authors.has(p.targetEventId))).map((p) => p.targetBlob));
    return parsed.map((p) => subjectOf(p, p.targetEventId ? authors.get(p.targetEventId) : undefined, p.targetBlob ? blobs.get(p.targetBlob) : undefined));
  }

  /** Stored records of reported blobs (for their uploaders); empty when Blossom is off. */
  private async blobs(hashes: (string | undefined)[]): Promise<Map<string, BlobRecord>> {
    const out = new Map<string, BlobRecord>();
    const blossom = this.deps.blossom;
    if (!blossom) return out;
    const unique = [...new Set(hashes)].filter((h): h is string => !!h && /^[0-9a-f]{64}$/.test(h));
    // a backfill page may look up many: keep the lookups in flight bounded
    for (const part of chunk(unique, 100)) for (const b of await Promise.all(part.map((h) => blossom.get(h)))) if (b) out.set(b.sha256, b);
    return out;
  }

  /** count of open reports per target key, one grouped query */
  private async relatedCounts(parsed: ParsedReport[]): Promise<Map<string, number>> {
    const keys = [...new Set(parsed.map(targetKey))];
    const counts = new Map<string, number>();
    for (const part of chunk(keys)) {
      const rows = await this.db.all<{ target_key: string; n: number | string }>(
        `SELECT target_key, COUNT(*) AS n FROM admin_report_index WHERE status = 'open' AND target_key IN (${placeholders(part.length)}) GROUP BY target_key`,
        part,
      );
      for (const r of rows) counts.set(r.target_key, Number(r.n));
    }
    return counts;
  }

  // ---------------------------------------------------------------- resolution

  /**
   * Applies a resolution action, filling `effects` as it goes (so a caller auditing in `finally` records partial work).
   * Caller is responsible for permission checks & auditing. `ip`: the client's, for Blossom's audit entry. `memo`: work
   * shared across a bulk resolution (each subject banned and each target deleted once).
   */
  async apply(
    id: string,
    req: ResolveReportRequest,
    actor: Actor,
    ip: string | null = null,
    effects: Record<string, unknown> = {},
    memo?: ResolveMemo,
  ): Promise<{ event: NostrEvent; parsed: ParsedReport; effects: Record<string, unknown> }> {
    const ev = await this.deps.stores.events.getById(id);
    if (!ev || ev.kind !== REPORT_KIND) throw notFound("report not found");
    const p = parseReport(ev);
    const wantsDelete = req.action === "delete-event" || req.action === "delete-and-ban";
    const wantsBan = req.action === "ban-user" || req.action === "delete-and-ban";
    if (wantsDelete && !p.targetEventId) throw badRequest("report has no target event");
    const target = (wantsDelete || wantsBan) && p.targetEventId ? await this.deps.stores.events.getById(p.targetEventId) : undefined;
    let subject: Subject | undefined;
    if (wantsBan) {
      // the ban (and its rank check) goes to the reported content's author, never to a `p` pubkey that doesn't match it
      const blob = !target && p.targetBlob ? (await this.blobs([p.targetBlob])).get(p.targetBlob) : undefined;
      subject = subjectOf(p, target?.pubkey, blob);
      if (!subject.pubkey) throw badRequest("report has no target pubkey");
      await this.once(memo, subject.pubkey, () => this.users.assertCanModerate(actor, subject!.pubkey));
    }
    if (wantsDelete && target) await this.users.assertCanDeleteEventsOf(actor, [target.pubkey]);
    if (req.action === "delete-media") {
      if (!p.targetBlob) throw badRequest("report has no target blob");
      if (!this.deps.blossom) throw notFound("blossom disabled", "blossom_disabled");
      // anyone can file a report naming any blob: deleting it follows the ranks against its uploaders
      const blob = (await this.blobs([p.targetBlob])).get(p.targetBlob);
      if (blob) await this.users.assertCanModerateBlob(actor, blob);
    }

    if (wantsDelete && p.targetEventId && !memo?.deletedEvents.has(p.targetEventId)) {
      memo?.deletedEvents.add(p.targetEventId);
      effects.deletedEvents = await this.deps.stores.events.deleteByIds([p.targetEventId]);
      this.deps.bus.emit("event.deleted", { ids: [p.targetEventId], actor: actor.pubkey, reason: req.note ?? `report ${id}` });
    }
    if (subject) {
      effects.banned = subject.pubkey;
      if (subject.claimed) effects.claimedPubkey = subject.claimed;
      if (!memo?.banned.has(subject.pubkey)) {
        memo?.banned.add(subject.pubkey);
        const r = await this.moderation.banUser(subject.pubkey, { reason: req.note ?? `report ${id}`, disconnect: true }, actor.pubkey);
        effects.disconnected = r.disconnected;
        if (r.unallowed) effects.unallowed = true;
      }
    }
    if (req.action === "delete-media" && p.targetBlob && this.deps.blossom && !memo?.deletedBlobs.has(p.targetBlob)) {
      memo?.deletedBlobs.add(p.targetBlob);
      await this.deps.blossom.delete(p.targetBlob, actor.pubkey, { block: true, ip });
      effects.deletedBlob = p.targetBlob;
    }
    await this.setStatus(id, req.action === "dismiss" ? "dismissed" : "resolved", req.action, actor.pubkey, req.note);
    return { event: ev, parsed: p, effects };
  }

  /** apply() and the updated view of the report. */
  async resolve(
    id: string,
    req: ResolveReportRequest,
    actor: Actor,
    ip: string | null = null,
    effects: Record<string, unknown> = {},
  ): Promise<{ report: ReportView; effects: Record<string, unknown> }> {
    const r = await this.apply(id, req, actor, ip, effects);
    return { report: await this.view(r.event), effects };
  }

  private once(memo: ResolveMemo | undefined, key: string, fn: () => Promise<void>): Promise<void> {
    if (!memo) return fn();
    let p = memo.checked.get(key);
    if (!p) memo.checked.set(key, (p = fn()));
    return p;
  }
}
