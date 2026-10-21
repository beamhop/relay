// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Baseline-aware anomaly detection (§8).
 *
 * Each signal (per relay, per minute) keeps:
 * - an EWMA of mean and variance (α = 0.05 per sample → roughly the last ~40 minutes), and
 * - a seasonal baseline: one EWMA per hour-of-week slot (168 slots, α = 0.1),
 *   capturing "Sunday evening is always busy".
 *
 * Expected value = EWMA alone until the current slot has ≥ 30 samples, then
 * the average of EWMA and the slot. Anomaly z = (x − mean) / max(σ, √mean, 1)
 * (√mean is a Poisson floor so quiet relays don't alarm on noise).
 * Observations are winsorised at mean + 3σ before updating, so a spike does
 * not instantly become the new normal.
 */

export interface Moments {
  mean: number;
  variance: number;
  n: number;
}

export function updateMoments(m: Moments, x: number, alpha: number): void {
  if (m.n === 0) {
    m.mean = x;
    m.variance = 0;
    m.n = 1;
    return;
  }
  const a = Math.max(alpha, 1 / (m.n + 1));
  const diff = x - m.mean;
  const incr = a * diff;
  m.mean += incr;
  m.variance = (1 - a) * (m.variance + diff * incr);
  m.n++;
}

export const EWMA_ALPHA = 0.05;
export const SLOT_ALPHA = 0.1;
export const SLOT_MIN_SAMPLES = 30;
/** Samples before anomaly rules may fire. */
export const WARMUP_SAMPLES = 30;

/** Hour-of-week slot (0 = Monday 00:00 UTC). */
export function hourOfWeek(t: number): number {
  const day = (Math.floor(t / 86400) + 3) % 7; // 1970-01-01 was a Thursday
  return day * 24 + Math.floor((t % 86400) / 3600);
}

export interface Expectation {
  mean: number;
  std: number;
  /** EWMA samples seen. */
  n: number;
  seasonal: boolean;
}

export interface BaselineState {
  ewma: Moments;
  slots: Array<Moments | null>;
}

export class Baseline {
  ewma: Moments;
  slots: Array<Moments | null>;

  constructor(state?: BaselineState) {
    this.ewma = state?.ewma ?? { mean: 0, variance: 0, n: 0 };
    this.slots = state?.slots ?? Array.from({ length: 168 }, () => null);
  }

  expected(t: number): Expectation {
    const slot = this.slots[hourOfWeek(t)];
    if (slot && slot.n >= SLOT_MIN_SAMPLES) {
      return {
        mean: (this.ewma.mean + slot.mean) / 2,
        std: Math.sqrt((this.ewma.variance + slot.variance) / 2),
        n: this.ewma.n,
        seasonal: true,
      };
    }
    return {
      mean: this.ewma.mean,
      std: Math.sqrt(this.ewma.variance),
      n: this.ewma.n,
      seasonal: false,
    };
  }

  /** z-score of x against the expectation at time t. */
  score(x: number, t: number): { z: number; exp: Expectation } {
    const exp = this.expected(t);
    const scale = Math.max(exp.std, Math.sqrt(Math.max(exp.mean, 0)), 1);
    return { z: (x - exp.mean) / scale, exp };
  }

  update(x: number, t: number): void {
    const exp = this.expected(t);
    const cap = exp.n >= WARMUP_SAMPLES ? exp.mean + 3 * Math.max(exp.std, 1) : x;
    const v = Math.min(x, cap);
    updateMoments(this.ewma, v, EWMA_ALPHA);
    const i = hourOfWeek(t);
    let slot = this.slots[i];
    if (!slot) {
      slot = { mean: 0, variance: 0, n: 0 };
      this.slots[i] = slot;
    }
    updateMoments(slot, v, SLOT_ALPHA);
  }

  toJSON(): BaselineState {
    return { ewma: this.ewma, slots: this.slots };
  }
}

/** Ordinary least squares: slope (units per second) and intercept. */
export function linearRegression(
  points: Array<{ t: number; v: number }>,
): { slope: number; intercept: number; r2: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const t0 = points[0]!.t;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const x = p.t - t0;
    sx += x;
    sy += p.v;
    sxx += x * x;
    sxy += x * p.v;
    syy += p.v * p.v;
  }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n - slope * t0;
  const varY = n * syy - sy * sy;
  const r2 = varY === 0 ? 1 : (n * sxy - sx * sy) ** 2 / (den * varY);
  return { slope, intercept, r2 };
}
