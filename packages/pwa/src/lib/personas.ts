// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Persona } from './api/types.ts';
import { m } from './paraglide/messages.js';

export interface PersonaInfo {
  id: Persona;
  title: string;
  description: string;
  emoji: string;
}

export function personas(): PersonaInfo[] {
  return [
    {
      id: 'public-social',
      title: m.persona_public_title(),
      description: m.persona_public_desc(),
      emoji: '🌍',
    },
    {
      id: 'private-team',
      title: m.persona_team_title(),
      description: m.persona_team_desc(),
      emoji: '🔒',
    },
    {
      id: 'wot-community',
      title: m.persona_wot_title(),
      description: m.persona_wot_desc(),
      emoji: '🤝',
    },
    {
      id: 'media-host',
      title: m.persona_media_title(),
      description: m.persona_media_desc(),
      emoji: '🖼️',
    },
    {
      id: 'organization',
      title: m.persona_org_title(),
      description: m.persona_org_desc(),
      emoji: '🏢',
    },
  ];
}

export function personaTitle(id: Persona | undefined): string {
  return personas().find((p) => p.id === id)?.title ?? '';
}
