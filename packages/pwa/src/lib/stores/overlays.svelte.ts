// SPDX-License-Identifier: AGPL-3.0-or-later
import { untrack } from 'svelte';

/** How many sheets/dialogs are open (toasts move out of their way). */
class Overlays {
  count = $state(0);

  /** Register an open overlay; returns the function that unregisters it. */
  open(): () => void {
    // Called from effects: never make the caller depend on the counter.
    untrack(() => this.count++);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      untrack(() => {
        this.count = Math.max(0, this.count - 1);
      });
    };
  }
}

export const overlays = new Overlays();
