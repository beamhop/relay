// SPDX-License-Identifier: AGPL-3.0-or-later
import { m } from '../paraglide/messages.js';

const TITLES: Record<string, () => string> = {
  profile: () => m.section_relay_info(),
  privacy: () => m.section_privacy(),
  access: () => m.section_access(),
  media: () => m.section_media(),
  alerts: () => m.section_alerts(),
  backups: () => m.section_backups(),
  domains: () => m.section_domains(),
  advanced: () => m.section_advanced(),
};

const SUMMARIES: Record<string, () => string> = {
  profile: () => m.section_relay_info_desc(),
  privacy: () => m.section_privacy_desc(),
  access: () => m.section_access_desc(),
  media: () => m.section_media_desc(),
  alerts: () => m.section_alerts_desc(),
  backups: () => m.section_backups_desc(),
  domains: () => m.section_domains_desc(),
  advanced: () => m.section_advanced_desc(),
};

export function sectionTitle(id: string): string {
  return TITLES[id]?.() ?? id;
}

export function sectionSummary(id: string): string {
  return SUMMARIES[id]?.() ?? '';
}
