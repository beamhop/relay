// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Internal notes (§6.12) on posts, people and files — visible to the admin
 * team only. One `notes.list` call per relay gives the counts for every
 * note button on screen; a sheet reads and adds notes (`notes.add`, undoable).
 */
import { app } from '../../stores/app.svelte.ts';

/** What a note is about. `pubkey` is the app's word for a person (the server calls it `user`). */
export interface NoteSubject {
  type: 'event' | 'pubkey' | 'blob';
  id: string;
}

export interface Note {
  id: string;
  relayId: string;
  subject: { type: 'user' | 'event' | 'blob'; id: string };
  text: string;
  author: string;
  authorName?: string;
  at: number;
}

export function serverSubject(s: NoteSubject): { type: 'user' | 'event' | 'blob'; id: string } {
  return { type: s.type === 'pubkey' ? 'user' : s.type, id: s.id };
}

export function subjectKey(s: { type: string; id: string }): string {
  return `${s.type === 'pubkey' ? 'user' : s.type}|${s.id}`;
}

/** Count notes per subject. */
export function countNotes(notes: readonly Note[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of notes) {
    const k = subjectKey(n.subject);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

class NotesStore {
  counts = $state<Record<string, number>>({});
  private loadedFor: string | null = null;
  private loading: Promise<void> | null = null;

  get available(): boolean {
    return app.hasAction('notes.list');
  }

  /** Load counts once per relay (call from any note button; concurrent calls share one request). */
  ensure(): Promise<void> {
    const relay = app.relayId ?? '';
    if (!this.available || this.loadedFor === relay) return Promise.resolve();
    this.loading ??= this.refresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  async refresh(): Promise<void> {
    const relay = app.relayId ?? '';
    try {
      const r = await app.api.run<{ notes: Note[] }>('notes.list', { limit: 500 });
      this.counts = countNotes(r.output.notes);
    } catch {
      this.counts = {};
    }
    this.loadedFor = relay;
  }

  count(s: NoteSubject): number {
    return this.counts[subjectKey(s)] ?? 0;
  }

  async list(s: NoteSubject): Promise<Note[]> {
    const r = await app.api.run<{ notes: Note[] }>('notes.list', {
      subject: serverSubject(s),
      limit: 100,
    });
    const k = subjectKey(s);
    this.counts = { ...this.counts, [k]: r.output.notes.length };
    return r.output.notes;
  }
}

export const notes = new NotesStore();
