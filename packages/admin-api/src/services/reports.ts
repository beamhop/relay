import type { AdminApiDeps, Filter, NostrEvent, Paged, ReportStatus, ReportView, ResolveReportRequest } from "@beamhop/sdk";
import { chunk, placeholders } from "../db";
import { badRequest, notFound } from "../errors";
import type { ProfileService } from "./profiles";
import type { Actor, UserService } from "./users";

export const REPORT_KIND = 1984;
/** max number of recent reports considered for listing/filtering */
const WINDOW = 5000;

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

export function parseReport(ev: NostrEvent): ParsedReport {
  const p = ev.tags.find((t) => t[0] === "p" && t[1]);
  const e = ev.tags.find((t) => t[0] === "e" && t[1]);
  const x = ev.tags.find((t) => t[0] === "x" && t[1]);
  const type = (e?.[2] || x?.[2] || p?.[2] || "other").toLowerCase();
  return { targetPubkey: p?.[1] ?? "", targetEventId: e?.[1], targetBlob: x?.[1], type };
}

const targetKey = (r: ParsedReport) =>
  r.targetEventId ? `e:${r.targetEventId}` : r.targetBlob ? `x:${r.targetBlob}` : `p:${r.targetPubkey}`;

export class ReportService {
  constructor(
    private readonly deps: AdminApiDeps,
    private readonly profiles: ProfileService,
    private readonly users: UserService,
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

  async list(q: { status?: ReportStatus; type?: string; target?: string; limit: number; offset: number }): Promise<Paged<ReportView>> {
    const events = await this.recent();
    const statuses = await this.statuses(events.map((e) => e.id));
    const filtered = events.filter((ev) => {
      const st = statuses.get(ev.id)?.status ?? "open";
      if (q.status && st !== q.status) return false;
      if (q.type || q.target) {
        const p = parseReport(ev);
        if (q.type && p.type !== q.type) return false;
        if (q.target && p.targetPubkey !== q.target && p.targetEventId !== q.target && p.targetBlob !== q.target) return false;
      }
      return true;
    });
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

  async view(ev: NostrEvent): Promise<ReportView> {
    return (await this.views([ev]))[0];
  }

  async views(events: NostrEvent[], known?: Map<string, StatusRow>): Promise<ReportView[]> {
    if (!events.length) return [];
    const statuses = known ?? (await this.statuses(events.map((e) => e.id)));
    const parsed = events.map(parseReport);
    const targetIds = [...new Set(parsed.map((p) => p.targetEventId).filter((x): x is string => !!x))];
    const targets = new Map<string, NostrEvent>();
    if (targetIds.length) {
      for (const ev of await this.deps.stores.events.query([{ ids: targetIds }], { maxLimit: targetIds.length })) targets.set(ev.id, ev);
    }
    const profiles = await this.profiles.getMany([...events.map((e) => e.pubkey), ...parsed.map((p) => p.targetPubkey)]);
    const related = await this.relatedCounts(parsed);
    return events.map((ev, i) => {
      const p = parsed[i];
      const st = statuses.get(ev.id);
      const view: ReportView = {
        id: ev.id,
        report: ev,
        reporter: ev.pubkey,
        reporterProfile: profiles.get(ev.pubkey),
        targetPubkey: p.targetPubkey,
        targetProfile: profiles.get(p.targetPubkey),
        targetEventId: p.targetEventId,
        targetEvent: p.targetEventId ? targets.get(p.targetEventId) : undefined,
        targetBlob: p.targetBlob,
        type: p.type,
        status: st?.status ?? "open",
        relatedCount: related.get(targetKey(p)) ?? 0,
      };
      if (st) view.resolution = { action: st.action, by: st.by, at: st.at, ...(st.note ? { note: st.note } : {}) };
      return view;
    });
  }

  /** count of open reports per target key */
  private async relatedCounts(parsed: ParsedReport[]): Promise<Map<string, number>> {
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
    const reports = await this.deps.stores.events.query(filters, { maxLimit: 10_000 });
    const statuses = await this.statuses(reports.map((r) => r.id));
    for (const r of reports) {
      if ((statuses.get(r.id)?.status ?? "open") !== "open") continue;
      const key = targetKey(parseReport(r));
      const [t, v] = [key.slice(0, 1), key.slice(2)];
      if ((t === "e" && e.has(v)) || (t === "x" && x.has(v)) || (t === "p" && p.has(v))) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  /** Applies a resolution action. Caller is responsible for permission checks & auditing. */
  async resolve(id: string, req: ResolveReportRequest, actor: Actor): Promise<{ report: ReportView; effects: Record<string, unknown> }> {
    const ev = await this.deps.stores.events.getById(id);
    if (!ev || ev.kind !== REPORT_KIND) throw notFound("report not found");
    const p = parseReport(ev);
    const effects: Record<string, unknown> = {};
    const wantsDelete = req.action === "delete-event" || req.action === "delete-and-ban";
    const wantsBan = req.action === "ban-user" || req.action === "delete-and-ban";
    if (wantsDelete && !p.targetEventId) throw badRequest("report has no target event");
    if (wantsBan && !p.targetPubkey) throw badRequest("report has no target pubkey");
    if (wantsBan) await this.users.assertCanModerate(actor, p.targetPubkey);
    if (req.action === "delete-media") {
      if (!p.targetBlob) throw badRequest("report has no target blob");
      if (!this.deps.blossom) throw notFound("blossom disabled", "blossom_disabled");
    }

    if (wantsDelete && p.targetEventId) {
      effects.deletedEvents = await this.deps.stores.events.deleteByIds([p.targetEventId]);
      this.deps.bus.emit("event.deleted", { ids: [p.targetEventId], actor: actor.pubkey, reason: req.note ?? `report ${id}` });
    }
    if (wantsBan) {
      const r = await this.users.ban(p.targetPubkey, { reason: req.note ?? `report ${id}`, disconnect: true }, actor.pubkey);
      effects.banned = p.targetPubkey;
      effects.disconnected = r.disconnected;
    }
    if (req.action === "delete-media" && p.targetBlob && this.deps.blossom) {
      await this.deps.blossom.delete(p.targetBlob, actor.pubkey, { block: true });
      effects.deletedBlob = p.targetBlob;
    }
    await this.setStatus(id, req.action === "dismiss" ? "dismissed" : "resolved", req.action, actor.pubkey, req.note);
    return { report: await this.view(ev), effects };
  }
}
