// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { SwipeRecognizer } from '../src/lib/gestures/recognizer.ts';

/** Drive a straight-line gesture from (0,0) to (dx,dy) over `ms`. */
function drag(r: SwipeRecognizer, dx: number, dy: number, ms = 300, steps = 10) {
  r.start(0, 0, 0);
  let last = r.move(0, 0, 0);
  for (let i = 1; i <= steps; i++)
    last = r.move((dx * i) / steps, (dy * i) / steps, (ms * i) / steps);
  return { last, end: r.end(dx, dy, ms) };
}

describe('SwipeRecognizer', () => {
  it('commits a horizontal swipe past the threshold', () => {
    const r = new SwipeRecognizer({ axis: 'x', threshold: 80 });
    expect(drag(r, 120, 4).end.direction).toBe('right');
    expect(drag(r, -120, -4).end.direction).toBe('left');
  });

  it('snaps back below the threshold for a slow drag', () => {
    const r = new SwipeRecognizer({ axis: 'x', threshold: 80 });
    expect(drag(r, 50, 0, 1000).end.direction).toBeNull();
  });

  it('commits a short fast flick', () => {
    const r = new SwipeRecognizer({ axis: 'x', threshold: 80, velocity: 0.5, minFlick: 30 });
    expect(drag(r, 50, 0, 60).end.direction).toBe('right');
  });

  it('gives up on vertical movement for an x-only element (lets the page scroll)', () => {
    const r = new SwipeRecognizer({ axis: 'x' });
    const { last, end } = drag(r, 5, 150);
    expect(last.ignored).toBe(true);
    expect(end.direction).toBeNull();
  });

  it('locks to the dominant axis and reports progress', () => {
    const r = new SwipeRecognizer({ axis: 'both', threshold: 100 });
    r.start(0, 0, 0);
    r.move(0, -10, 10);
    const s = r.move(4, -50, 50);
    expect(s.locked).toBe('y');
    expect(s.direction).toBe('up');
    expect(s.dx).toBe(0);
    expect(s.progress).toBeCloseTo(0.5);
    expect(r.end(4, -120, 120).direction).toBe('up');
  });

  it('only commits allowed directions', () => {
    const r = new SwipeRecognizer({ axis: 'x', directions: ['left'] });
    expect(drag(r, 200, 0).end.direction).toBeNull();
    expect(drag(r, -200, 0).end.direction).toBe('left');
  });

  it('supports the four triage directions', () => {
    const r = new SwipeRecognizer({ axis: 'both', threshold: 80 });
    expect(drag(r, 0, 150).end.direction).toBe('down');
    expect(drag(r, 0, -150).end.direction).toBe('up');
    expect(drag(r, 150, 0).end.direction).toBe('right');
    expect(drag(r, -150, 0).end.direction).toBe('left');
  });

  it('is inert before start and after cancel', () => {
    const r = new SwipeRecognizer();
    expect(r.end(100, 0, 10).direction).toBeNull();
    r.start(0, 0, 0);
    r.cancel();
    expect(r.active).toBe(false);
  });
});
