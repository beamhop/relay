// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Swipe recognizer: a small pure state machine over pointer samples, so it can
 * be unit-tested without a DOM. The Svelte action in `swipe.ts` feeds it
 * pointer events.
 *
 * - Axis lock: after `lockDistance` px the gesture locks to the dominant axis.
 *   A horizontal-only recognizer that locks vertically gives up (page scroll).
 * - A swipe commits when the travelled distance passes `threshold`, or when a
 *   fast flick (`velocity` px/ms) travelled at least `minFlick` px.
 */

export type Direction = 'left' | 'right' | 'up' | 'down';
export type Axis = 'x' | 'y' | 'both';

export interface SwipeOptions {
  axis?: Axis;
  /** Distance (px) that commits a swipe. */
  threshold?: number;
  /** Flick velocity (px/ms) that commits a shorter swipe. */
  velocity?: number;
  minFlick?: number;
  lockDistance?: number;
  /** Allowed directions (default: all on the axis). */
  directions?: Direction[];
}

export interface SwipeState {
  dx: number;
  dy: number;
  /** Locked axis, or null before the lock distance. */
  locked: 'x' | 'y' | null;
  /** True once the recognizer gave up (e.g. vertical scroll on an x-only element). */
  ignored: boolean;
  /** Candidate direction for the current offset (null when not allowed). */
  direction: Direction | null;
  /** 0..1 progress towards the commit threshold. */
  progress: number;
}

interface Sample {
  x: number;
  y: number;
  t: number;
}

export class SwipeRecognizer {
  private readonly o: Required<Omit<SwipeOptions, 'directions'>> & { directions: Direction[] };
  private origin: Sample | null = null;
  private samples: Sample[] = [];
  private lockedAxis: 'x' | 'y' | null = null;
  private ignoredFlag = false;

  constructor(opts: SwipeOptions = {}) {
    const axis = opts.axis ?? 'x';
    const all: Direction[] =
      axis === 'x'
        ? ['left', 'right']
        : axis === 'y'
          ? ['up', 'down']
          : ['left', 'right', 'up', 'down'];
    this.o = {
      axis,
      threshold: opts.threshold ?? 96,
      velocity: opts.velocity ?? 0.6,
      minFlick: opts.minFlick ?? 32,
      lockDistance: opts.lockDistance ?? 8,
      directions: opts.directions ?? all,
    };
  }

  get active(): boolean {
    return this.origin !== null && !this.ignoredFlag;
  }

  start(x: number, y: number, t: number): void {
    this.origin = { x, y, t };
    this.samples = [{ x, y, t }];
    this.lockedAxis = null;
    this.ignoredFlag = false;
  }

  private directionOf(dx: number, dy: number): Direction | null {
    const axis = this.lockedAxis ?? (Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y');
    const d: Direction = axis === 'x' ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'down' : 'up';
    if ((axis === 'x' ? dx : dy) === 0) return null;
    return this.o.directions.includes(d) ? d : null;
  }

  private state(dx: number, dy: number): SwipeState {
    const dist =
      this.lockedAxis === 'y' ? Math.abs(dy) : this.lockedAxis === 'x' ? Math.abs(dx) : 0;
    const direction = this.ignoredFlag ? null : this.directionOf(dx, dy);
    return {
      dx: this.lockedAxis === 'y' && this.o.axis === 'both' ? 0 : dx,
      dy: this.lockedAxis === 'x' && this.o.axis === 'both' ? 0 : dy,
      locked: this.lockedAxis,
      ignored: this.ignoredFlag,
      direction,
      progress: direction ? Math.min(1, dist / this.o.threshold) : 0,
    };
  }

  move(x: number, y: number, t: number): SwipeState {
    if (!this.origin) return this.state(0, 0);
    const dx = x - this.origin.x;
    const dy = y - this.origin.y;
    this.samples.push({ x, y, t });
    if (this.samples.length > 6) this.samples.shift();
    if (!this.lockedAxis && Math.hypot(dx, dy) >= this.o.lockDistance) {
      this.lockedAxis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      if (this.o.axis !== 'both' && this.lockedAxis !== this.o.axis) this.ignoredFlag = true;
    }
    if (this.ignoredFlag) return { ...this.state(0, 0), ignored: true };
    const s = this.state(dx, dy);
    if (this.o.axis === 'x') s.dy = 0;
    if (this.o.axis === 'y') s.dx = 0;
    return s;
  }

  /** Finish the gesture; returns the committed direction or null (snap back). */
  end(x: number, y: number, t: number): { direction: Direction | null; dx: number; dy: number } {
    if (!this.origin || this.ignoredFlag) {
      this.origin = null;
      return { direction: null, dx: 0, dy: 0 };
    }
    const s = this.move(x, y, t);
    const first = this.samples[0] ?? { x, y, t };
    const dt = Math.max(1, t - first.t);
    const vx = (x - first.x) / dt;
    const vy = (y - first.y) / dt;
    const axis = this.lockedAxis;
    this.origin = null;
    if (!axis || !s.direction) return { direction: null, dx: s.dx, dy: s.dy };
    const dist = Math.abs(axis === 'x' ? s.dx : s.dy);
    const v = Math.abs(axis === 'x' ? vx : vy);
    const flick = v >= this.o.velocity && dist >= this.o.minFlick;
    return {
      direction: dist >= this.o.threshold || flick ? s.direction : null,
      dx: s.dx,
      dy: s.dy,
    };
  }

  cancel(): void {
    this.origin = null;
    this.ignoredFlag = false;
    this.lockedAxis = null;
  }
}
