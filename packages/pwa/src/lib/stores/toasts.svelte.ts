// SPDX-License-Identifier: AGPL-3.0-or-later
/** Undo toasts (§6.2): every change shows what happened with a one-tap undo. */

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'error';
  /** Undo handler; present when the change can still be reverted. */
  undo?: () => Promise<void>;
  /** Unix seconds when the server-side undo expires. */
  undoExpiresAt?: number;
  /** Optional "Why?" details (error technical text). */
  detail?: string;
}

let seq = 0;

export class Toasts {
  items = $state<Toast[]>([]);
  /** Most recent undoable change, for the `u` shortcut and the toast. */
  lastUndo = $state<Toast | null>(null);
  private timers = new Map<number, ReturnType<typeof setTimeout>>();

  show(t: Omit<Toast, 'id'>, ms = t.undo ? 8000 : 4000): number {
    const id = ++seq;
    const toast: Toast = { ...t, id };
    this.items = [...this.items.slice(-2), toast];
    if (toast.undo) this.lastUndo = toast;
    this.timers.set(
      id,
      setTimeout(() => this.dismiss(id), ms),
    );
    return id;
  }

  success(message: string, undo?: () => Promise<void>, undoExpiresAt?: number): number {
    const t: Omit<Toast, 'id'> = { message, kind: 'success' };
    if (undo) t.undo = undo;
    if (undoExpiresAt) t.undoExpiresAt = undoExpiresAt;
    return this.show(t);
  }

  error(message: string, detail?: string): number {
    const t: Omit<Toast, 'id'> = { message, kind: 'error' };
    if (detail) t.detail = detail;
    return this.show(t, 6000);
  }

  dismiss(id: number): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.items = this.items.filter((t) => t.id !== id);
  }

  /** Run the undo of a toast (or the latest undoable change). */
  async undo(id?: number): Promise<boolean> {
    const t = id
      ? (this.items.find((x) => x.id === id) ?? (this.lastUndo?.id === id ? this.lastUndo : null))
      : this.lastUndo;
    if (!t?.undo) return false;
    const fn = t.undo;
    t.undo = undefined;
    if (this.lastUndo?.id === t.id) this.lastUndo = null;
    this.dismiss(t.id);
    await fn();
    return true;
  }
}

export const toasts = new Toasts();
