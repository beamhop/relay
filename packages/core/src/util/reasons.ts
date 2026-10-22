import type { RejectCode } from "@beamhop/sdk";

export const PREFIXES = [
  "invalid",
  "pow",
  "duplicate",
  "blocked",
  "rate-limited",
  "auth-required",
  "restricted",
  "error",
  "mute",
] as const;

const PREFIX_RE = /^([a-z-]+):/;

/** Ensures a reason string carries a standard machine-readable prefix. */
export function withPrefix(reason: string | undefined, fallback: string = "blocked"): string {
  const r = (reason ?? "").trim();
  const m = PREFIX_RE.exec(r);
  if (m && (PREFIXES as readonly string[]).includes(m[1])) return r;
  return r ? `${fallback}: ${r}` : `${fallback}:`;
}

/** Maps an OK/CLOSED reason to a bus RejectCode. */
export function codeOf(reason: string): RejectCode {
  const m = PREFIX_RE.exec(reason);
  const p = m?.[1];
  switch (p) {
    case "invalid":
    case "pow":
    case "duplicate":
    case "blocked":
    case "rate-limited":
    case "auth-required":
    case "restricted":
    case "error":
      return p;
    default:
      return "blocked";
  }
}
