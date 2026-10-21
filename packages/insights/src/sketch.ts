// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Streaming quantile sketch with bounded relative error (DDSketch-style,
 * Masson et al. 2019). Values are mapped to logarithmic buckets of ratio
 * γ = (1+α)/(1-α); any quantile estimate is within α relative error of the
 * true value. Constant memory per bucket, mergeable, no sorting.
 *
 * Used for p50/p95/p99 latency (ms). Values ≤ `minValue` collapse into a zero bucket.
 */
export class QuantileSketch {
  private readonly gamma: number;
  private readonly logGamma: number;
  private readonly buckets = new Map<number, number>();
  private zero = 0;
  count = 0;
  sum = 0;
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;

  constructor(
    readonly relativeAccuracy = 0.01,
    private readonly minValue = 1e-3,
    /** Hard cap on buckets; lowest buckets are merged when exceeded. */
    private readonly maxBuckets = 2048,
  ) {
    this.gamma = (1 + relativeAccuracy) / (1 - relativeAccuracy);
    this.logGamma = Math.log(this.gamma);
  }

  add(value: number, weight = 1): void {
    if (!Number.isFinite(value) || weight <= 0) return;
    this.count += weight;
    this.sum += value * weight;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    if (value <= this.minValue) {
      this.zero += weight;
      return;
    }
    const k = Math.ceil(Math.log(value) / this.logGamma);
    this.buckets.set(k, (this.buckets.get(k) ?? 0) + weight);
    if (this.buckets.size > this.maxBuckets) this.collapse();
  }

  private collapse(): void {
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    const [a, b] = keys;
    if (a === undefined || b === undefined) return;
    this.buckets.set(b, (this.buckets.get(b) ?? 0) + (this.buckets.get(a) ?? 0));
    this.buckets.delete(a);
  }

  /** q in [0,1]. Returns 0 for an empty sketch. */
  quantile(q: number): number {
    if (this.count === 0) return 0;
    if (q <= 0) return this.min;
    if (q >= 1) return this.max;
    const rank = q * (this.count - 1);
    let seen = this.zero;
    if (rank < seen) return Math.max(this.min, 0);
    const keys = [...this.buckets.keys()].sort((a, b) => a - b);
    for (const k of keys) {
      seen += this.buckets.get(k) ?? 0;
      if (rank < seen) {
        // Midpoint of the bucket (γ^(k-1), γ^k] in relative terms.
        const v = (2 * this.gamma ** k) / (1 + this.gamma);
        return Math.min(Math.max(v, this.min), this.max);
      }
    }
    return this.max;
  }

  merge(other: QuantileSketch): void {
    if (other.count === 0) return;
    for (const [k, n] of other.buckets) this.buckets.set(k, (this.buckets.get(k) ?? 0) + n);
    this.zero += other.zero;
    this.count += other.count;
    this.sum += other.sum;
    this.min = Math.min(this.min, other.min);
    this.max = Math.max(this.max, other.max);
    while (this.buckets.size > this.maxBuckets) this.collapse();
  }

  reset(): void {
    this.buckets.clear();
    this.zero = 0;
    this.count = 0;
    this.sum = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
  }

  clone(): QuantileSketch {
    const s = new QuantileSketch(this.relativeAccuracy, this.minValue, this.maxBuckets);
    s.merge(this);
    return s;
  }
}
