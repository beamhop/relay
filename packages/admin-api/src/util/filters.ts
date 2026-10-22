import { z } from "zod";
import type { Filter } from "@beamhop/sdk";
import { badRequest } from "../errors";
import { tryParsePubkey } from "./pubkey";
import { validate } from "./request";

const TAG_KEY = /^#[a-zA-Z]$/;
const KNOWN = new Set(["ids", "authors", "kinds", "since", "until", "limit", "search"]);

export const FilterSchema = z
  .object({
    ids: z.array(z.string().regex(/^[0-9a-fA-F]{1,64}$/)).max(5000).optional(),
    authors: z
      .array(z.string().max(200))
      .max(5000)
      .transform((a) => a.map((x) => tryParsePubkey(x) ?? x.toLowerCase()))
      .optional(),
    kinds: z.array(z.number().int().min(0).max(65535)).max(500).optional(),
    since: z.number().int().min(0).optional(),
    until: z.number().int().min(0).optional(),
    limit: z.number().int().min(0).optional(),
    search: z.string().max(500).optional(),
  })
  .catchall(z.array(z.string().max(1024)).max(5000))
  .superRefine((f, ctx) => {
    for (const k of Object.keys(f)) {
      if (!KNOWN.has(k) && !TAG_KEY.test(k)) ctx.addIssue({ code: "custom", message: `unknown filter key ${k}`, path: [k] });
    }
  })
  .transform((f) => f as Filter);

export const FiltersSchema = z.array(FilterSchema).min(1).max(20);

/** true if the filter constrains anything besides `limit` (guards destructive ops) */
export const isConstrained = (f: Filter) => Object.entries(f).some(([k, v]) => k !== "limit" && v !== undefined);

export function parseFiltersParam(raw: string | undefined): Filter[] {
  if (!raw) return [{}];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw badRequest("filters must be URL-encoded JSON");
  }
  return validate(FiltersSchema, Array.isArray(json) ? json : [json]);
}
