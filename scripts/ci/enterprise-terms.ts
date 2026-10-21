// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Enterprise vocabulary that must never reach a vanilla admin (PLAN §12.0.6): not in the
 * first-load admin bundle, not in the wizard, not in the action catalog or config schema
 * of a node without enterprise modules. Shared by `scripts/ci/vanilla-check.ts` and
 * `packages/runtime-bun/test/vanilla.test.ts`.
 *
 * Matching is case-insensitive. Keep entries specific enough not to hit ordinary words
 * ("Vault" is matched as a whole word so "vaulted" does not count).
 */
export const ENTERPRISE_TERMS: ReadonlyArray<{ term: string; pattern: RegExp }> = [
  { term: 'SCIM', pattern: /\bscim\b/i },
  { term: 'Company groups', pattern: /company groups/i },
  { term: 'Company keys', pattern: /company keys/i },
  { term: 'Company sign-in', pattern: /company sign-in/i },
  { term: 'Company directory', pattern: /company directory/i },
  { term: 'eDiscovery', pattern: /e-?discovery/i },
  { term: 'legal hold', pattern: /legal hold/i },
  { term: 'SIEM', pattern: /\bsiem\b/i },
  { term: 'Entra', pattern: /\bentra\b/i },
  { term: 'Okta', pattern: /\bokta\b/i },
  { term: 'KMS', pattern: /\bkms\b/i },
  { term: 'Vault', pattern: /\bvault\b/i },
  { term: 'escrow', pattern: /escrow/i },
  { term: 'two-person', pattern: /two-person/i },
  { term: 'second admin', pattern: /second admin/i },
  { term: 'Approvals', pattern: /\bapprovals\b/i },
  { term: 'mTLS', pattern: /\bmtls\b/i },
];

/** Action id prefixes that belong to enterprise modules. */
export const ENTERPRISE_ACTION_PREFIXES = [
  'enterprise.',
  'compliance.',
  'keyvault.',
  'approvals.',
  'identity.',
  'network.',
] as const;

/** Config/module keys that belong to enterprise modules. */
export const ENTERPRISE_CONFIG_KEYS = /^(enterprise|enterprise-.*|compliance|keyvault|identity)$/;

export interface AllowEntry {
  term: string;
  /** Matched against ~40 characters of context around the hit. */
  context: RegExp;
  reason: string;
}

/**
 * Hits that are allowed in vanilla code. Keep this short; every entry needs a reason.
 * The "Company / Organization" persona in the wizard is the single entry point to
 * enterprise features (§12.0.1); the text of the step it opens is part of that entry point.
 */
export const VANILLA_ALLOWLIST: AllowEntry[] = [
  {
    term: 'Company directory',
    context: /connect your company directory/i,
    reason:
      'Wizard text wizard_org_body, shown only after picking the Company / Organization persona (the entry point, §12.0.1).',
  },
  {
    term: 'Company sign-in',
    context: /finish it later in Settings › Company sign-in/i,
    reason:
      'Wizard text wizard_org_later, shown only after picking the Company / Organization persona (the entry point, §12.0.1).',
  },
  {
    term: 'Company sign-in',
    context: /"Company sign-in"\)/,
    reason:
      'Message company_title: the Settings entry and page title, shown only for the Organization persona or once company sign-in is on (the entry point, §12.0.1).',
  },
];

/** Hits not covered by `allow`. */
export function unallowed(hits: TermHit[], allow: AllowEntry[] = VANILLA_ALLOWLIST): TermHit[] {
  return hits.filter((h) => !allow.some((a) => a.term === h.term && a.context.test(h.context)));
}

export interface TermHit {
  term: string;
  match: string;
  context: string;
}

/** Every enterprise term in `text`, with ~40 characters of context around each hit. */
export function findEnterpriseTerms(text: string): TermHit[] {
  const hits: TermHit[] = [];
  for (const { term, pattern } of ENTERPRISE_TERMS) {
    const global = new RegExp(pattern.source, 'gi');
    for (const m of text.matchAll(global)) {
      const at = m.index ?? 0;
      hits.push({
        term,
        match: m[0],
        context: text.slice(Math.max(0, at - 40), at + m[0].length + 40).replace(/\s+/g, ' '),
      });
    }
  }
  return hits;
}
