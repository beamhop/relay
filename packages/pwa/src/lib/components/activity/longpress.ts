// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Long-press (touch and mouse) to start selecting (§6.13 bulk actions on phones).
 * Moving more than a few pixels cancels it, so swipes keep working; the click
 * that follows a long-press is swallowed.
 */
import type { Action } from 'svelte/action';
import { haptic } from '../../haptics.ts';

export interface LongPressOptions {
  onlongpress: () => void;
  ms?: number;
  enabled?: boolean;
}

const SLOP = 8;

export const longpress: Action<HTMLElement, LongPressOptions> = (node, initial) => {
  let opts = initial;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let x = 0;
  let y = 0;
  let fired = false;

  const move = (e: PointerEvent) => {
    if (timer && Math.hypot(e.clientX - x, e.clientY - y) > SLOP) cancel();
  };
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    // Released after a long-press: the click (if any) follows right away.
    if (fired) setTimeout(() => window.removeEventListener('click', swallow, true), 1000);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', cancel);
    window.removeEventListener('pointercancel', cancel);
  };
  const down = (e: PointerEvent) => {
    if (opts.enabled === false || e.button > 0) return;
    fired = false;
    x = e.clientX;
    y = e.clientY;
    cancel();
    // Window listeners: a swipe may capture the pointer on an outer element.
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', cancel);
    window.addEventListener('pointercancel', cancel);
    timer = setTimeout(() => {
      timer = null;
      fired = true;
      haptic('tap');
      // The screen may change under the finger (a bulk bar appears): swallow the
      // click that ends this press wherever it lands.
      window.addEventListener('click', swallow, true);
      setTimeout(() => window.removeEventListener('click', swallow, true), 10_000);
      opts.onlongpress();
    }, opts.ms ?? 500);
  };
  const swallow = (e: MouseEvent) => {
    window.removeEventListener('click', swallow, true);
    fired = false;
    e.preventDefault();
    e.stopPropagation();
  };
  const menu = (e: Event) => {
    if (timer || fired) e.preventDefault();
  };

  node.addEventListener('pointerdown', down);
  node.addEventListener('contextmenu', menu);
  return {
    update(next) {
      opts = next;
    },
    destroy() {
      // After a long-press the element often goes away while the finger is still
      // down: leave the window listeners to clean up on release.
      if (fired) {
        if (timer) clearTimeout(timer);
        timer = null;
      } else cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('contextmenu', menu);
    },
  };
};
