import { z } from "zod";
import type { EventView, Filter, ImportResult, NostrEvent } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import { FiltersSchema, isConstrained, parseFiltersParam } from "../util/filters";
import { isNostrEventShape, isValidSignedEvent } from "../util/nip98";
import { parseEventId } from "../util/pubkey";
import { readBody } from "../util/request";

const MAX_QUERY_LIMIT = 500;
const EXPORT_CAP = 1_000_000;
const EXPORT_PAGE = 1000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IMPORT_ERRORS = 100;

const QuerySchema = z.object({ filters: FiltersSchema, limit: z.number().int().min(1).optional() });
const DeleteOne = z.object({ reason: z.string().max(1000).optional() });
const DeleteMany = z
  .object({ ids: z.array(z.string()).max(10_000).optional(), filters: FiltersSchema.optional(), reason: z.string().max(1000).optional() })
  .refine((b) => (b.ids?.length ?? 0) > 0 || (b.filters?.length ?? 0) > 0, "ids or filters required");

export function registerContentRoutes(app: AdminApp, ctx: ApiContext) {
  const { stores, relay, bus } = ctx.deps;

  async function toViews(events: NostrEvent[]): Promise<EventView[]> {
    if (!events.length) return [];
    const ids = events.map((e) => e.id);
    const [profiles, reports] = await Promise.all([
      ctx.profiles.getMany(events.map((e) => e.pubkey)),
      stores.events.query([{ kinds: [1984], "#e": ids }], { maxLimit: 5000 }),
    ]);
    const idSet = new Set(ids);
    const counts = new Map<string, number>();
    for (const r of reports) {
      const targets = new Set(r.tags.filter((t) => t[0] === "e" && idSet.has(t[1])).map((t) => t[1]));
      for (const t of targets) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return events.map((event) => ({ event, author: profiles.get(event.pubkey), reports: counts.get(event.id) ?? 0 }));
  }

  app.post("/events/query", requirePermission("content.view"), async (c) => {
    const body = await readBody(c, QuerySchema);
    const limit = Math.min(body.limit ?? 100, MAX_QUERY_LIMIT);
    const filters = body.filters.map((f) => ({ ...f, limit: Math.min(f.limit ?? limit, limit) }));
    const events = (await stores.events.query(filters, { maxLimit: limit })).slice(0, limit);
    return c.json({ items: await toViews(events) });
  });

  app.get("/events/export", requirePermission("content.export"), async (c) => {
    const filters = parseFiltersParam(c.req.query("filters"));
    const iter = exportEvents(filters);
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let chunk = "";
          for (let i = 0; i < 200; i++) {
            const r = await iter.next();
            if (r.done) {
              if (chunk) controller.enqueue(enc.encode(chunk));
              controller.close();
              return;
            }
            chunk += JSON.stringify(r.value) + "\n";
          }
          controller.enqueue(enc.encode(chunk));
        } catch (err) {
          ctx.logger.error("export failed", { error: String(err) });
          controller.error(err);
        }
      },
      async cancel() {
        await iter.return(undefined);
      },
    });
    await ctx.audit(c, "event.export", null, { filters });
    const name = `beamhop-export-${new Date(ctx.nowMs()).toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  async function* exportEvents(filters: Filter[]): AsyncGenerator<NostrEvent> {
    const seen = filters.length > 1 ? new Set<string>() : null;
    let total = 0;
    for (const original of filters) {
      const { limit: filterLimit, ...f } = original;
      let remaining = filterLimit && filterLimit > 0 ? filterLimit : Infinity;
      let until = f.until;
      let boundaryTs = -1;
      const boundary = new Set<string>();
      while (remaining > 0 && total < EXPORT_CAP) {
        const page = Math.min(EXPORT_PAGE, remaining, EXPORT_CAP - total);
        const batch = await stores.events.query([{ ...f, limit: page, ...(until !== undefined ? { until } : {}) }], { maxLimit: page });
        let fresh = 0;
        for (const ev of batch) {
          if (ev.created_at === boundaryTs && boundary.has(ev.id)) continue;
          if (seen) {
            if (seen.has(ev.id)) continue;
            seen.add(ev.id);
          }
          fresh++;
          total++;
          remaining--;
          yield ev;
          if (remaining <= 0 || total >= EXPORT_CAP) break;
        }
        if (batch.length < page) break;
        const last = batch[batch.length - 1].created_at;
        if (last !== boundaryTs) {
          boundary.clear();
          boundaryTs = last;
        }
        for (const ev of batch) if (ev.created_at === last) boundary.add(ev.id);
        if (fresh === 0) {
          // more than a page of events share one timestamp; step past it
          until = last - 1;
          boundary.clear();
          boundaryTs = -1;
        } else until = last;
        if (until < 0) break;
      }
    }
  }

  app.post("/events/import", requirePermission("content.import"), async (c) => {
    const bypass = c.req.query("bypassPolicies") === "true";
    const result: ImportResult = { imported: 0, duplicates: 0, rejected: 0, errors: [] };
    const err = (line: number, msg: string) => {
      result.rejected++;
      if (result.errors.length < MAX_IMPORT_ERRORS) result.errors.push(`line ${line}: ${msg}`);
    };

    const handle = async (line: string, n: number) => {
      const s = line.trim();
      if (!s) return;
      let ev: unknown;
      try {
        ev = JSON.parse(s);
      } catch {
        return err(n, "invalid JSON");
      }
      if (Array.isArray(ev) && ev[0] === "EVENT") ev = ev[ev.length - 1];
      if (!isNostrEventShape(ev)) return err(n, "not a nostr event");
      if (bypass) {
        if (!isValidSignedEvent(ev)) return err(n, "invalid: bad id or signature");
        const r = await stores.events.save(ev);
        if (r.status === "saved" || r.status === "replaced") result.imported++;
        else if (r.status === "duplicate" || r.status === "stale") result.duplicates++;
        else err(n, r.message ?? r.status);
        return;
      }
      const r = await relay.publish(ev, "import");
      if (r.ok) {
        if (/^duplicate:/i.test(r.message)) result.duplicates++;
        else result.imported++;
      } else if (/^duplicate:/i.test(r.message)) result.duplicates++;
      else err(n, r.message || "rejected");
    };

    const body = c.req.raw.body;
    if (!body) throw badRequest("empty body");
    const reader = body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    let lineNo = 0;
    let skipping = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        lineNo++;
        if (skipping) {
          skipping = false;
          continue;
        }
        await handle(line, lineNo);
      }
      if (buf.length > MAX_LINE_BYTES) {
        if (!skipping) err(lineNo + 1, "line too long");
        skipping = true;
        buf = "";
      }
      if (done) break;
    }
    if (buf.trim() && !skipping) await handle(buf, ++lineNo);

    await ctx.audit(c, "event.import", null, { bypassPolicies: bypass, imported: result.imported, duplicates: result.duplicates, rejected: result.rejected });
    return c.json(result);
  });

  app.post("/events/delete", requirePermission("content.delete"), async (c) => {
    const body = await readBody(c, DeleteMany);
    const actor = principalOf(c).pubkey;
    let deleted = 0;
    const ids = (body.ids ?? []).map((id) => parseEventId(id));
    if (ids.length) deleted += await stores.events.deleteByIds(ids);
    const affected = [...ids];
    if (body.filters?.length) {
      if (!body.filters.every(isConstrained)) throw badRequest("every filter must constrain at least one field");
      const found = await stores.events.query(body.filters.map((f) => ({ ...f, limit: undefined })), { maxLimit: 10_000 });
      affected.push(...found.map((e) => e.id));
      deleted += await stores.events.deleteByFilter(body.filters);
    }
    if (affected.length) bus.emit("event.deleted", { ids: affected, actor, reason: body.reason });
    await ctx.audit(c, "event.delete", null, { ids: ids.slice(0, 100), filters: body.filters, deleted, reason: body.reason });
    return c.json({ deleted });
  });

  app.get("/events/:id", requirePermission("content.view"), async (c) => {
    const ev = await stores.events.getById(parseEventId(c.req.param("id")));
    if (!ev) throw notFound("event not found");
    return c.json((await toViews([ev]))[0]);
  });

  app.delete("/events/:id", requirePermission("content.delete"), async (c) => {
    const id = parseEventId(c.req.param("id"));
    const { reason } = await readBody(c, DeleteOne);
    const ev = await stores.events.getById(id);
    if (!ev) throw notFound("event not found");
    const deleted = await stores.events.deleteByIds([id]);
    bus.emit("event.deleted", { ids: [id], actor: principalOf(c).pubkey, reason });
    await ctx.audit(c, "event.delete", id, { kind: ev.kind, pubkey: ev.pubkey, reason });
    return c.json({ deleted });
  });
}
