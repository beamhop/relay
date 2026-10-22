import type { Logger, NostrEvent, RuntimeSettings, SettingsService, WordFilter } from "@beamhop/sdk";

export type PolicyVerdict =
  | { action: "pass" }
  | { action: "reject"; reason: string }
  | { action: "shadow"; reason: string }
  | { action: "report"; reason: string; filter: WordFilter };

interface Compiled {
  filter: WordFilter;
  kinds: Set<number> | null;
  test: (content: string) => boolean;
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
      let test: (c: string) => boolean;
      if (f.isRegex) {
        try {
          const re = new RegExp(f.pattern, "iu");
          test = (c) => re.test(c);
        } catch (err) {
          this.logger.warn("invalid word filter regex ignored", { id: f.id, err: String(err) });
          continue;
        }
      } else {
        const needle = f.pattern.toLowerCase();
        test = (c) => c.toLowerCase().includes(needle);
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
    for (const c of this.compiled) {
      if (c.kinds && !c.kinds.has(event.kind)) continue;
      if (!c.test(event.content)) continue;
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
