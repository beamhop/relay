import type { AdminApiDeps, BlobRecord, Filter, NostrEvent, Paged, ReportStatus, ReportView, ResolveReportRequest } from "@beamhop/sdk";
import { chunk, placeholders } from "../db";
import { badRequest, notFound } from "../errors";
import type { ModerationService } from "./moderation";
import type { ProfileService } from "./profiles";
import type { Actor, UserService } from "./users";

const REPORT_KIND = 1984;
/** max number of recent reports considered for listing/filtering */
const WINDOW = 5000;
/** report types are short NIP-56 words; longer values (reporter-controlled) are cut */
export const MAX_REPORT_TYPE = 32;
/** reports loaded to count open reports per target when building views */
const RELATED_LIMIT = 10_000;

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
function subjectOf(p: ParsedReport, eventAuthor?: string, blob?: BlobRecord): { pubkey: string; claimed?: string } {
  let pubkey = p.targetPubkey;
  if (eventAuthor) pubkey = eventAuthor;
  else if (blob?.owners.length && !blob.owners.includes(pubkey)) pubkey = blob.owners.length === 1 ? blob.owners[0] : "";
  return p.targetPubkey && p.targetPubkey !== pubkey ? { pubkey, claimed: p.targetPubkey } : { pubkey };
}

const targetKey = (r: ParsedReport) =>
  r.targetEventId ? `e:${r.targetEventId}` : r.targetBlob ? `x:${r.targetBlob}` : `p:${r.targetPubkey}`;

export class ReportService {
  constructor(
    private readonly deps: AdminApiDeps,
    private readonly profiles: ProfileService,
    private readonly users: UserService,
    private readonly moderation: ModerationService,
    private readonly nowSec: () => number,
  ) {}

  async statuses(ids: string[]): Promise<Map<string, StatusRow>> {
    const out = new Map<string, StatusRow>();
    for (const part of chunk([...new Set(ids)])) {
      if (!part.length) continue;
      const rows = await this.deps.stores.db.all<{ report_id: string } & StatusRow>(
        `SELECT report_id, status, action, by, at, note FROM admin_report_status WHERE report_id IN (${placeholders(part.length)})`,
        part,
      );
      for (const r of rows) out.set(r.report_id, { status: r.status, action: r.action, by: r.by, at: Number(r.at), note: r.note });
    }
    return out;
  }

  async setStatus(id: string, status: ReportStatus, action: string, by: string, note?: string | null): Promise<void> {
    await this.deps.stores.db.run(
      `INSERT INTO admin_report_status (report_id, status, action, by, at, note) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (report_id) DO UPDATE SET status = excluded.status, action = excluded.action, by = excluded.by, at = excluded.at, note = excluded.note`,
      [id, status, action, by, this.nowSec(), note ?? null],
    );
  }

  private recent(): Promise<NostrEvent[]> {
    return this.deps.stores.events.query([{ kinds: [REPORT_KIND], limit: WINDOW }], { maxLimit: WINDOW });
  }

  /**
   * `target`: a reported event id or blob hash, or a pubkey matched against each report's subject — the view's
   * `targetPubkey` (the stored content's author / uploader, else the `p` tag), not the `p` tag alone.
   */
  async list(q: { status?: ReportStatus; type?: string; target?: string; limit: number; offset: number }): Promise<Paged<ReportView>> {
    const events = await this.recent();
    const statuses = await this.statuses(events.map((e) => e.id));
    let filtered = events.filter((ev) => {
      const st = statuses.get(ev.id)?.status ?? "open";
      if (q.status && st !== q.status) return false;
      return !q.type || parseReport(ev).type === q.type;
    });
    if (q.target) {
      const t = q.target;
      const about = /^[0-9a-f]{64}$/.test(t) ? await this.aboutPubkey(filtered, t) : new Set<string>();
      filtered = filtered.filter((ev) => {
        const p = parseReport(ev);
        return p.targetEventId === t || p.targetBlob === t || about.has(ev.id);
      });
    }
    const page = filtered.slice(q.offset, q.offset + q.limit);
    return { items: await this.views(page, statuses), total: filtered.length };
  }

  /** Open reports (for NIP-86 listeventsneedingmoderation). */
  async open(limit = 1000): Promise<{ event: NostrEvent; parsed: ParsedReport }[]> {
    const events = await this.recent();
    const statuses = await this.statuses(events.map((e) => e.id));
    return events
      .filter((e) => (statuses.get(e.id)?.status ?? "open") === "open")
      .slice(0, limit)
      .map((event) => ({ event, parsed: parseReport(event) }));
  }

  async get(id: string): Promise<ReportView | undefined> {
    const ev = await this.deps.stores.events.getById(id);
    if (!ev || ev.kind !== REPORT_KIND) return undefined;
    return (await this.views([ev]))[0];
  }

  /** `relatedLimit`: reports loaded to compute `relatedCount` (0 skips it: the count is then 0) */
  async view(ev: NostrEvent, opts: { relatedLimit?: number } = {}): Promise<ReportView> {
    return (await this.views([ev], undefined, opts))[0];
  }

  async views(events: NostrEvent[], known?: Map<string, StatusRow>, opts: { relatedLimit?: number } = {}): Promise<ReportView[]> {
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
    const related = await this.relatedCounts(parsed, opts.relatedLimit ?? RELATED_LIMIT);
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

  /**
   * Ids of the reports (among `reports`, at most the listing window) whose subject is `pubkey`, decided like subjectOf
   * with bounded lookups: an ids+author query for the reported events by `pubkey`; an ids query for the other reported
   * events whose report could still point at `pubkey` through its `p` tag or a blob (a stored event by someone else
   * overrides both); and the reported blobs not settled by a stored event.
   */
  private async aboutPubkey(reports: NostrEvent[], pubkey: string): Promise<Set<string>> {
    const parsed = reports.map((ev) => ({ ev, p: parseReport(ev) }));
    const stored = async (ids: string[], authors?: string[]) => {
      const out = new Map<string, string>();
      for (const part of chunk([...new Set(ids)])) {
        const filter: Filter = { ids: part, limit: part.length, ...(authors ? { authors } : {}) };
        for (const ev of await this.deps.stores.events.query([filter], { maxLimit: part.length })) out.set(ev.id, ev.pubkey);
      }
      return out;
    };
    const authors = await stored(parsed.flatMap(({ p }) => (p.targetEventId ? [p.targetEventId] : [])), [pubkey]);
    const unsettled = parsed.filter(({ p }) => p.targetEventId && !authors.has(p.targetEventId) && (p.targetPubkey === pubkey || p.targetBlob));
    for (const [id, author] of await stored(unsettled.map(({ p }) => p.targetEventId!))) authors.set(id, author);
    const blobs = await this.blobs(
      parsed.filter(({ p }) => p.targetBlob && !(p.targetEventId && authors.has(p.targetEventId))).map(({ p }) => p.targetBlob),
    );
    const out = new Set<string>();
    for (const { ev, p } of parsed) {
      // a reported event not looked up can't make `pubkey` the subject, whether stored or not
      const author = p.targetEventId ? authors.get(p.targetEventId) : undefined;
      if (subjectOf(p, author, p.targetBlob ? blobs.get(p.targetBlob) : undefined).pubkey === pubkey) out.add(ev.id);
    }
    return out;
  }

  /** Stored records of reported blobs (for their uploaders); empty when Blossom is off. */
  private async blobs(hashes: (string | undefined)[]): Promise<Map<string, BlobRecord>> {
    const out = new Map<string, BlobRecord>();
    const blossom = this.deps.blossom;
    if (!blossom) return out;
    const unique = [...new Set(hashes)].filter((h): h is string => !!h && /^[0-9a-f]{64}$/.test(h));
    // a filtered listing may look up a whole window's worth: keep the lookups in flight bounded
    for (const part of chunk(unique, 100)) for (const b of await Promise.all(part.map((h) => blossom.get(h)))) if (b) out.set(b.sha256, b);
    return out;
  }

  /** count of open reports per target key */
  private async relatedCounts(parsed: ParsedReport[], limit: number): Promise<Map<string, number>> {
    if (limit <= 0) return new Map();
    const e = new Set<string>();
    const x = new Set<string>();
    const p = new Set<string>();
    for (const r of parsed) {
      if (r.targetEventId) e.add(r.targetEventId);
      else if (r.targetBlob) x.add(r.targetBlob);
      else if (r.targetPubkey) p.add(r.targetPubkey);
    }
    const filters: Filter[] = [];
    if (e.size) filters.push({ kinds: [REPORT_KIND], "#e": [...e] });
    if (x.size) filters.push({ kinds: [REPORT_KIND], "#x": [...x] });
    if (p.size) filters.push({ kinds: [REPORT_KIND], "#p": [...p] });
    const counts = new Map<string, number>();
    if (!filters.length) return counts;
    const reports = await this.deps.stores.events.query(filters, { maxLimit: limit });
    const statuses = await this.statuses(reports.map((r) => r.id));
    for (const r of reports) {
      if ((statuses.get(r.id)?.status ?? "open") !== "open") continue;
      const key = targetKey(parseReport(r));
      const [t, v] = [key.slice(0, 1), key.slice(2)];
      if ((t === "e" && e.has(v)) || (t === "x" && x.has(v)) || (t === "p" && p.has(v))) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /** Applies a resolution action. Caller is responsible for permission checks & auditing. `ip`: the client's, for Blossom's audit entry. */
  async resolve(id: string, req: ResolveReportRequest, actor: Actor, ip: string | null = null): Promise<{ report: ReportView; effects: Record<string, unknown> }> {
    const ev = await this.deps.stores.events.getById(id);
    if (!ev || ev.kind !== REPORT_KIND) throw notFound("report not found");
    const p = parseReport(ev);
    const effects: Record<string, unknown> = {};
    const wantsDelete = req.action === "delete-event" || req.action === "delete-and-ban";
    const wantsBan = req.action === "ban-user" || req.action === "delete-and-ban";
    if (wantsDelete && !p.targetEventId) throw badRequest("report has no target event");
    const target = (wantsDelete || wantsBan) && p.targetEventId ? await this.deps.stores.events.getById(p.targetEventId) : undefined;
    let subject: { pubkey: string; claimed?: string } | undefined;
    if (wantsBan) {
      // the ban (and its rank check) goes to the reported content's author, never to a `p` pubkey that doesn't match it
      const blob = !target && p.targetBlob ? (await this.blobs([p.targetBlob])).get(p.targetBlob) : undefined;
      subject = subjectOf(p, target?.pubkey, blob);
      if (!subject.pubkey) throw badRequest("report has no target pubkey");
      await this.users.assertCanModerate(actor, subject.pubkey);
    }
    if (wantsDelete && target) await this.users.assertCanDeleteEventsOf(actor, [target.pubkey]);
    if (req.action === "delete-media") {
      if (!p.targetBlob) throw badRequest("report has no target blob");
      if (!this.deps.blossom) throw notFound("blossom disabled", "blossom_disabled");
      // anyone can file a report naming any blob: deleting it follows the ranks against its uploaders
      const blob = (await this.blobs([p.targetBlob])).get(p.targetBlob);
      if (blob) await this.users.assertCanModerateBlob(actor, blob);
    }

    if (wantsDelete && p.targetEventId) {
      effects.deletedEvents = await this.deps.stores.events.deleteByIds([p.targetEventId]);
      this.deps.bus.emit("event.deleted", { ids: [p.targetEventId], actor: actor.pubkey, reason: req.note ?? `report ${id}` });
    }
    if (subject) {
      const r = await this.moderation.banUser(subject.pubkey, { reason: req.note ?? `report ${id}`, disconnect: true }, actor.pubkey);
      effects.banned = subject.pubkey;
      effects.disconnected = r.disconnected;
      if (r.unallowed) effects.unallowed = true;
      if (subject.claimed) effects.claimedPubkey = subject.claimed;
    }
    if (req.action === "delete-media" && p.targetBlob && this.deps.blossom) {
      await this.deps.blossom.delete(p.targetBlob, actor.pubkey, { block: true, ip });
      effects.deletedBlob = p.targetBlob;
    }
    await this.setStatus(id, req.action === "dismiss" ? "dismissed" : "resolved", req.action, actor.pubkey, req.note);
    return { report: await this.view(ev), effects };
  }
}
