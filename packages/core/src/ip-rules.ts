import type { IpRuleStore, Logger } from "@beamhop/sdk";
import { type Cidr, cidrContains, parseCidr, parseIp } from "./util/cidr";

interface CompiledRule {
  cidr: Cidr;
  raw: string;
  action: "block" | "allow";
  reason: string;
}

export interface IpVerdict {
  blocked: boolean;
  /** matched an explicit allow rule (exempt from per-IP connection limits) */
  allowed: boolean;
  reason?: string;
}

/** In-memory compiled copy of IP rules; refreshed periodically. Allow rules win over block rules. */
export class IpRuleCache {
  private rules: CompiledRule[] = [];
  private verdicts = new Map<string, IpVerdict>();

  constructor(private readonly store: IpRuleStore, private readonly logger: Logger) {}

  async refresh(): Promise<void> {
    try {
      const list = await this.store.list();
      const compiled: CompiledRule[] = [];
      for (const r of list) {
        const cidr = parseCidr(r.cidr);
        if (!cidr) {
          this.logger.warn("ignoring invalid ip rule", { cidr: r.cidr });
          continue;
        }
        compiled.push({ cidr, raw: r.cidr, action: r.action, reason: r.reason });
      }
      this.rules = compiled;
      this.verdicts.clear();
    } catch (err) {
      this.logger.error("failed to refresh ip rules", { err: String(err) });
    }
  }

  check(ip: string): IpVerdict {
    const cached = this.verdicts.get(ip);
    if (cached) return cached;
    const parsed = parseIp(ip);
    let verdict: IpVerdict = { blocked: false, allowed: false };
    if (parsed) {
      let block: CompiledRule | undefined;
      let allow = false;
      for (const r of this.rules) {
        if (!cidrContains(r.cidr, parsed)) continue;
        if (r.action === "allow") allow = true;
        else block ??= r;
      }
      verdict = allow ? { blocked: false, allowed: true } : block ? { blocked: true, allowed: false, reason: block.reason || `ip ${block.raw} blocked` } : verdict;
    }
    if (this.verdicts.size > 10_000) this.verdicts.clear();
    this.verdicts.set(ip, verdict);
    return verdict;
  }
}
