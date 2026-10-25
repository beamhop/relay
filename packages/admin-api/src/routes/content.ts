import { z } from "zod";
import type { EventView, Filter, ImportResult, NostrEvent } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import { IMPORT_MAX_BYTES, requirePermission } from "../middleware/auth";
import { auditLists } from "../util/audit";
import { FiltersSchema, isConstrained, parseFiltersParam } from "../util/filters";
import { isNostrEventShape, isValidSignedEvent } from "../util/nip98";
import { parseEventId } from "../util/pubkey";
import { readBody } from "../util/request";

const MAX_QUERY_LIMIT = 500;
const EXPORT_CAP = 1_000_000;
const EXPORT_PAGE = 1000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_IMPORT_ERRORS = 100;
/** max ids reported in the `event.deleted` bus event of a delete */
const AFFECTED_CAP = 10_000;
/** filter deletes below owner resolve matches page by page within this budget, then report `truncated` */
const DELETE_MAX_PAGES = 10;
const DELETE_BUDGET_MS = 10_000;
/**
 * max full events loaded for a single second when more than a page shares one created_at (export and
 * filter delete); the store can't page within a second, so beyond this export warns and delete reports `truncated`
 */
const SAME_SECOND_CAP = 10_000;

const QuerySchema = z.object({ filters: FiltersSchema, limit: z.number().int().min(1).optional() });
const DeleteOne = z.object({ reason: z.string().max(1000).optional() });
const DeleteMany = z
  .object({ ids: z.array(z.string()).max(10_000).optional(), filters: FiltersSchema.optional(), reason: z.string().max(1000).optional() })
  .refine((b) => (b.ids?.length ?? 0) > 0 || (b.filters?.length ?? 0) > 0, "ids or filters required");

export function registerContentRoutes(app: AdminApp, ctx: ApiContext) {
  const { stores, relay, bus } = ctx.deps;

  async function toViews(events: NostrEvent[]): Promise<EventView[]> {
    if (!events.length) return [];
    // report counts per event: one grouped query on the report index (reports naming the event as their target)
    const [profiles, counts] = await Promise.all([
      ctx.profiles.getMany(events.map((e) => e.pubkey)),
      ctx.reports.countsForEvents(events.map((e) => e.id)),
    ]);
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
        // `progressed`: the page held events not already yielded at the page boundary (independent of
        // cross-filter dedupe, which may legitimately skip a whole page)
        let progressed = false;
        for (const ev of batch) {
          if (ev.created_at === boundaryTs && boundary.has(ev.id)) continue;
          progressed = true;
          if (seen) {
            if (seen.has(ev.id)) continue;
            seen.add(ev.id);
          }
          total++;
          remaining--;
          yield ev;
          if (remaining <= 0 || total >= EXPORT_CAP) break;
        }
        if (batch.length < page || remaining <= 0 || total >= EXPORT_CAP) break;
        const last = batch[batch.length - 1].created_at;
        if (last !== boundaryTs) {
          boundary.clear();
          boundaryTs = last;
        }
        for (const ev of batch) if (ev.created_at === last) boundary.add(ev.id);
        if (!progressed) {
          // more than a page of events share one timestamp: fetch that whole second, then step past it
          const cap = Math.min(SAME_SECOND_CAP, boundary.size + Math.min(remaining, EXPORT_CAP - total));
          const all = await stores.events.query([{ ...f, since: last, until: last, limit: cap }], { maxLimit: cap });
          if (all.length >= cap && cap === SAME_SECOND_CAP) ctx.logger.warn("export: more events share one second than can be loaded; some were skipped", { created_at: last, cap });
          for (const ev of all) {
            if (boundary.has(ev.id)) continue;
            if (seen) {
              if (seen.has(ev.id)) continue;
              seen.add(ev.id);
            }
            total++;
            remaining--;
            yield ev;
            if (remaining <= 0 || total >= EXPORT_CAP) break;
          }
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
        // stored without going through the relay, so without its "report.created": the queue indexes it here
        if ((r.status === "saved" || r.status === "replaced") && ev.kind === 1984) await ctx.reports.index([ev]);
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

    const maxBytes = ctx.opts.importMaxBytes ?? IMPORT_MAX_BYTES;
    if (Number(c.req.header("content-length") ?? 0) > maxBytes) throw new HttpError(413, `import body exceeds ${maxBytes} bytes`, "too_large");
    const body = c.req.raw.body;
    if (!body) throw badRequest("empty body");
    // counted as it streams (chunked bodies carry no Content-Length): past the cap, reading stops and the lines
    // already imported stay imported (the audit entry and the 413 say how many)
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let tooLarge = false;
    let buf = "";
    let lineNo = 0;
    let skipping = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          tooLarge = true;
          await reader.cancel().catch(() => {});
          break;
        }
        buf += decoder.decode(value, { stream: true });
      }
      if (done) buf += decoder.decode();
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
    // a body cut off by the cap ends mid-line: its last partial line is dropped, not imported
    if (!tooLarge && buf.trim() && !skipping) await handle(buf, ++lineNo);

    await ctx.audit(c, "event.import", null, {
      bypassPolicies: bypass,
      imported: result.imported,
      duplicates: result.duplicates,
      rejected: result.rejected,
      ...(tooLarge ? { truncatedAtBytes: maxBytes } : {}),
    });
    if (tooLarge) {
      throw new HttpError(413, `import body exceeds ${maxBytes} bytes: stopped after line ${lineNo} (${result.imported} imported, ${result.duplicates} duplicates, ${result.rejected} rejected)`, "too_large");
    }
    return c.json(result);
  });

  app.post("/events/delete", requirePermission("content.delete"), async (c) => {
    const body = await readBody(c, DeleteMany);
    const actor = principalOf(c);
    let deleted = 0;
    let truncated = false;
    const ids = (body.ids ?? []).map((id) => parseEventId(id));
    const filters = body.filters ?? [];
    if (!filters.every(isConstrained)) throw badRequest("every filter must constrain at least one field");
    // every rank check runs before anything is deleted, so a refused request deletes nothing
    if (ids.length && actor.role !== "owner") {
      await ctx.users.assertCanDeleteEventsOf(actor, (await stores.events.query([{ ids }], { maxLimit: ids.length })).map((e) => e.pubkey));
    }
    /** filters the store deletes directly (owner, or naming only deletable authors) */
    const direct: Filter[] = [];
    /** ids resolved from the other filters (below owner) */
    const matched: string[] = [];
    if (actor.role === "owner") direct.push(...filters);
    else if (filters.length) {
      // below owner a filter could match a superior's events: filters naming only deletable authors go
      // straight to the store (expired events included); others are resolved page by page, rank-checked
      // against the staff set and deleted by id. Past the page/time budget `truncated` asks to repeat.
      const prot = await ctx.users.protectedAuthors(actor);
      const started = performance.now();
      let pages = 0;
      for (const f of filters) {
        if (f.authors?.length) {
          const denied = f.authors.find((a) => prot.has(a));
          if (denied) throw forbidden(`cannot delete events of a user with role ${prot.get(denied)}`, "forbidden_target");
          direct.push(f);
          continue;
        }
        const seen = new Set<string>();
        /** seen ids per created_at, to size the same-second fetch */
        const seenAt = new Map<number, number>();
        let remaining = f.limit ?? Number.POSITIVE_INFINITY;
        let until = f.until;
        while (remaining > 0) {
          if (pages >= DELETE_MAX_PAGES || performance.now() - started > DELETE_BUDGET_MS) {
            truncated = true;
            break;
          }
          pages++;
          const cap = Math.min(remaining, AFFECTED_CAP);
          const page = await stores.events.query([{ ...f, until, limit: cap }], { maxLimit: AFFECTED_CAP });
          let fresh = 0;
          const take = (e: { id: string; pubkey: string; created_at: number }) => {
            if (fresh >= remaining || seen.has(e.id)) return;
            seen.add(e.id);
            seenAt.set(e.created_at, (seenAt.get(e.created_at) ?? 0) + 1);
            fresh++;
            const role = prot.get(e.pubkey);
            if (role) throw forbidden(`cannot delete events of a user with role ${role}`, "forbidden_target");
            matched.push(e.id);
          };
          page.forEach(take);
          if (page.length < cap) {
            remaining -= fresh;
            break;
          }
          // nothing is deleted yet, so page backwards
          const oldest = page[page.length - 1].created_at;
          if (fresh) {
            remaining -= fresh;
            until = oldest;
            continue;
          }
          // a whole page shares one created_at (bot floods often do): take that entire second, then step past it
          pages++;
          const secondCap = Math.min(SAME_SECOND_CAP, (seenAt.get(oldest) ?? 0) + remaining);
          const second = await stores.events.query([{ ...f, since: oldest, until: oldest, limit: secondCap }], { maxLimit: secondCap });
          second.forEach(take);
          remaining -= fresh;
          if (remaining <= 0) break;
          if (second.length >= secondCap) {
            // more of this second may remain than can be loaded at once: delete what we have, ask to repeat
            truncated = true;
            break;
          }
          until = oldest - 1;
        }
      }
    }

    const affected = [...ids];
    if (ids.length) deleted += await stores.events.deleteByIds(ids);
    if (direct.length) {
      // one query per filter so each keeps its own `limit` — the same rows deleteByFilter removes
      // (newest first); without limit it's capped, so the emitted id list may be partial for huge deletes
      for (const f of direct) {
        const found = await stores.events.query([{ ...f, limit: Math.min(f.limit ?? AFFECTED_CAP, AFFECTED_CAP) }], { maxLimit: AFFECTED_CAP });
        affected.push(...found.map((e) => e.id));
      }
      deleted += await stores.events.deleteByFilter(direct);
    }
    const unique = [...new Set(matched)];
    if (unique.length) {
      deleted += await stores.events.deleteByIds(unique);
      affected.push(...unique);
    }
    const affectedIds = [...new Set(affected)].slice(0, AFFECTED_CAP);
    if (affectedIds.length) bus.emit("event.deleted", { ids: affectedIds, actor: actor.pubkey, reason: body.reason });
    // the targets: the ids asked for and the ids the filters matched (lists capped, counts exact)
    const explicit = new Set(ids);
    const matchedIds = affectedIds.filter((id) => !explicit.has(id));
    await ctx.audit(c, "event.delete", null, {
      ...auditLists(matchedIds.length ? { ids, matchedIds } : { ids }),
      filters: body.filters,
      deleted,
      reason: body.reason,
    });
    return c.json(truncated ? { deleted, truncated } : { deleted });
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
    await ctx.users.assertCanDeleteEventsOf(principalOf(c), [ev.pubkey]);
    const deleted = await stores.events.deleteByIds([id]);
    bus.emit("event.deleted", { ids: [id], actor: principalOf(c).pubkey, reason });
    await ctx.audit(c, "event.delete", id, { kind: ev.kind, pubkey: ev.pubkey, reason });
    return c.json({ deleted });
  });
}
