// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every user-facing string of the public pages lives here (i18n-ready).
 * Add a locale by adding a dictionary with the same keys to `LOCALES`.
 * Placeholders use `{name}` and are filled by {@link fmt}.
 */

const en = {
  'nav.home': 'Home',
  'nav.portal': 'My account',
  'nav.status': 'Status',
  'nav.skip': 'Skip to content',
  'footer.powered': 'Runs on Beamhop',
  'footer.source': 'Source code',

  'landing.connect.title': 'How to connect',
  'landing.connect.body':
    'Add this address to the relay list of your Nostr app (Damus, Amethyst, Primal, Coracle…).',
  'landing.connect.qr': 'Scan with your phone to copy the relay address',
  'landing.media.title': 'Media hosting',
  'landing.media.body':
    'Upload photos, videos and files here. Add this address as a media server in your app.',
  'landing.copy': 'Copy',
  'landing.copied': 'Copied',
  'landing.rules.title': 'Community rules',
  'landing.rules.link': 'Read the rules',
  'landing.access.title': 'Who can post',
  'landing.access.open': 'Anyone can post here.',
  'landing.access.allowlist':
    'This relay is invite-only. Members can post; everyone else can read.',
  'landing.access.allowlist.private': 'This relay is invite-only.',
  'landing.access.wot':
    'This relay uses a web of trust: you can post if people the owner follows (up to {depth} steps away) follow you.',
  'landing.access.wot.min': 'At least {count} trusted people need to follow you.',
  'landing.access.readAuth': 'You need to sign in with your Nostr app to read.',
  'landing.access.writeAuth': 'Your app signs in automatically before posting.',
  'landing.join.title': 'Join with an invite',
  'landing.join.body': 'Got an invite code? Enter it and confirm with your Nostr extension.',
  'landing.join.code': 'Invite code',
  'landing.join.submit': 'Join',
  'landing.wot.title': 'How to get in',
  'landing.wot.body':
    'Ask someone the community already trusts to follow you. Access updates a few times a day.',
  'landing.contact': 'Contact',
  'landing.owner': 'Run by',

  'status.badge.ok': 'All systems normal',
  'status.badge.minor': 'Degraded performance',
  'status.badge.major': 'Partial outage',
  'status.badge.outage': 'Major outage',
  'status.title': 'Status',
  'status.uptime': 'Uptime, last {days} days',
  'status.uptime.pct': '{pct}% uptime',
  'status.uptime.nodata': 'No data',
  'status.uptime.since': 'Running for {duration} since the last restart.',
  'status.uptime.legend': 'Each bar is one day; hover a bar for its date and uptime.',
  'status.current': 'Current incidents',
  'status.none': 'No incidents right now.',
  'status.past': 'Recently resolved',
  'status.state.investigating': 'Investigating',
  'status.state.identified': 'Identified',
  'status.state.monitoring': 'Monitoring',
  'status.state.resolved': 'Resolved',
  'status.impact.minor': 'Minor',
  'status.impact.major': 'Major',
  'status.impact.outage': 'Outage',
  'status.opened': 'Opened {when}',

  'portal.title': 'My account',
  'portal.login.title': 'Sign in',
  'portal.login.body':
    'Sign in with your Nostr browser extension (Alby, nos2x, Nostash…). Nothing is posted; your extension only proves the key is yours.',
  'portal.login.button': 'Sign in with extension',
  'portal.login.noext': 'No Nostr extension found. Install one, then reload this page.',
  'portal.login.failed': 'Sign-in failed. Please try again.',
  'portal.login.nojs': 'Signing in needs JavaScript and a Nostr browser extension.',
  'portal.logout': 'Sign out',
  'portal.you': 'Signed in as',
  'portal.plan.title': 'Your plan',
  'portal.plan.tier': 'Plan: {name}',
  'portal.plan.rate': 'Up to {n} posts per minute',
  'portal.plan.size': 'Posts up to {size} each',
  'portal.plan.fileSize': 'Files up to {size} each',
  'portal.plan.retention': 'Posts are kept for {days} days',
  'portal.plan.retention.forever': 'Posts are kept until you delete them',
  'portal.plan.access.member': 'You can post here.',
  'portal.plan.access.notMember': 'You can read, but cannot post yet.',
  'portal.storage.title': 'Storage',
  'portal.storage.used': '{used} of {quota} used',
  'portal.storage.left': '{used} of {quota} used · {left} left',
  'portal.storage.full': 'Your storage is full. Delete some files to upload new ones.',
  'portal.storage.over':
    'You are storing more than your limit ({over} over). Delete some files to upload new ones.',
  'portal.files.title': 'Your files',
  'portal.files.none': 'You have not uploaded any files here.',
  'portal.files.delete': 'Delete',
  'portal.files.deleted': 'File deleted.',
  'portal.files.more': 'Showing your {n} most recent files.',
  'portal.export.title': 'Download my data',
  'portal.export.body':
    'Get a copy of everything you posted here plus a list of your files, one item per line (NDJSON).',
  'portal.export.button': 'Download',
  'portal.invite.title': 'Redeem an invite',
  'portal.invite.ok': 'Welcome! You can now post here.',
  'portal.invite.unknown': 'That invite code does not exist.',
  'portal.invite.expired': 'That invite has expired.',
  'portal.invite.used-up': 'That invite has already been used.',
  'portal.invite.unavailable': 'Invites are not available on this relay.',
  'portal.vanish.title': 'Delete everything (right to vanish)',
  'portal.vanish.body':
    'Permanently removes all your posts and files from this relay and stops them from being stored again. This cannot be undone.',
  'portal.vanish.confirm': 'Type DELETE to confirm',
  'portal.vanish.button': 'Delete everything',
  'portal.vanish.done': 'Done. {events} posts and {files} files were removed.',
  'portal.vanish.needsSign': 'Your extension must sign the deletion request.',
  'portal.vanish.bad': 'The deletion request was not valid. Nothing was deleted.',
  'portal.error.session': 'Your session expired. Please sign in again.',
  'portal.error.csrf': 'This form expired. Please try again.',

  'error.notFound': 'Page not found',
  'error.back': 'Back to the start page',
} as const;

export type StringKey = keyof typeof en;
export type Strings = Record<StringKey, string>;

export const LOCALES: Record<string, Strings> = { en };
export const DEFAULT_LOCALE = 'en';

/** Pick a locale from an Accept-Language header. */
export function pickLocale(acceptLanguage: string | undefined): string {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  for (const part of acceptLanguage.split(',')) {
    const tag = (part.split(';')[0] ?? '').trim().toLowerCase();
    const base = tag.split('-')[0] ?? '';
    if (LOCALES[tag]) return tag;
    if (LOCALES[base]) return base;
  }
  return DEFAULT_LOCALE;
}

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

export function fmt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function translator(locale: string): Translate {
  const dict = LOCALES[locale] ?? en;
  return (key, vars) => fmt(dict[key] ?? en[key], vars);
}

/** Human-readable byte size, e.g. 1.5 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
