// SPDX-License-Identifier: AGPL-3.0-or-later
/** Haptic feedback via the Vibration API, where available (no-op elsewhere, e.g. iOS Safari). */

const PATTERNS = {
  tap: 8,
  success: [10, 40, 10],
  warning: [20, 60, 20],
  swipe: 12,
} as const;

export function haptic(kind: keyof typeof PATTERNS = 'tap'): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(PATTERNS[kind] as number | number[]);
    }
  } catch {
    // ignore: some browsers throw without a user gesture
  }
}
