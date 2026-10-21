// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Long-press (phone multi-select, §6.13): fires after `ms` without moving;
 * the click that follows the release is swallowed so the row does not open.
 */
import type { Action } from 'svelte/action';

export interface LongPressOptions {
  onpress: () => void;
  ms?: number;
  /** Movement (px) that cancels the press — a swipe or a scroll. */
  slop?: number;
}

export const longpress: Action<HTMLElement, LongPressOptions> = (node, initial) => {
  let opts = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;
  let fired = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      opts.onpress();
    }, opts.ms ?? 500);
  };
  const move = (e: PointerEvent) => {
    if (!start) return;
    const slop = opts.slop ?? 10;
    if (Math.abs(e.clientX - start.x) > slop || Math.abs(e.clientY - start.y) > slop) cancel();
  };
  const click = (e: MouseEvent) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const menu = (e: Event) => {
    if (fired || timer) e.preventDefault();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', cancel);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', menu);
  return {
    update(next) {
      opts = next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('pointerleave', cancel);
      node.removeEventListener('click', click, true);
      node.removeEventListener('contextmenu', menu);
    },
  };
};
