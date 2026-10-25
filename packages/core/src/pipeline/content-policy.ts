import { compileRegexFilter, type Logger, type NostrEvent, type RuntimeSettings, type SettingsService, type WordFilter } from "@beamhop/sdk";

export type PolicyVerdict =
  | { action: "pass" }
  | { action: "reject"; reason: string }
  | { action: "shadow"; reason: string }
  | { action: "report"; reason: string; filter: WordFilter };

interface Compiled {
  filter: WordFilter;
  kinds: Set<number> | null;
  /** `lower()` is the lowercased content, computed once per evaluation */
  test: (content: string, lower: () => string) => boolean;
}

/** Built-in content policies: kind allow/block lists and word/regex filters (compiled & cached per settings revision). */
export class ContentPolicy {
  private compiled: Compiled[] | null = null;
  private unsub: () => void;

  constructor(private readonly settings: SettingsService, private readonly logger: Logger) {
    this.unsub = settings.onChange(() => (this.compiled = null));
  }

  private compile(s: RuntimeSettings): Compiled[] {
    const out: Compiled[] = [];
    for (const f of s.moderation.wordFilters) {
      if (!f.enabled || !f.pattern) continue;
      let test: Compiled["test"];
      if (f.isRegex) {
        // stored settings may predate the save-time check: never run a pattern that can backtrack catastrophically
        const compiled = compileRegexFilter(f.pattern);
        if ("reason" in compiled) {
          this.logger.warn("unsafe or invalid word filter regex ignored", { id: f.id, reason: compiled.reason });
          continue;
        }
        test = (c) => compiled.test(c);
      } else {
        const needle = f.pattern.toLowerCase();
        test = (_c, lower) => lower().includes(needle);
      }
      out.push({ filter: f, kinds: f.kinds.length ? new Set(f.kinds) : null, test });
    }
    return out;
  }

  evaluate(event: NostrEvent): PolicyVerdict {
    const s = this.settings.get();
    const { kindAllowlist, kindBlocklist } = s.moderation;
    if (kindAllowlist.length && !kindAllowlist.includes(event.kind)) return { action: "reject", reason: `blocked: kind ${event.kind} is not allowed on this relay` };
    if (kindBlocklist.includes(event.kind)) return { action: "reject", reason: `blocked: kind ${event.kind} is not allowed on this relay` };
    this.compiled ??= this.compile(s);
    let report: PolicyVerdict | undefined;
    let lowered: string | undefined;
    const lower = () => (lowered ??= event.content.toLowerCase());
    for (const c of this.compiled) {
      if (c.kinds && !c.kinds.has(event.kind)) continue;
      if (!c.test(event.content, lower)) continue;
      if (c.filter.action === "reject") return { action: "reject", reason: "blocked: content not allowed by relay policy" };
      if (c.filter.action === "shadow") return { action: "shadow", reason: `word filter ${c.filter.id}` };
      report ??= { action: "report", reason: `word filter ${c.filter.id}`, filter: c.filter };
    }
    return report ?? { action: "pass" };
  }

  dispose() {
    this.unsub();
  }
}
