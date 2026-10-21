// SPDX-License-Identifier: AGPL-3.0-or-later
/** Advisor cards dismissed on this device (localStorage; a convenience, never required). */

const KEY = 'beamhop.advisor.dismissed';

function read(): Set<string> {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(
      Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function write(s: Set<string>): Set<string> {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, JSON.stringify([...s]));
  } catch {
    // storage blocked: dismissals last until reload
  }
  return new Set(s);
}

export function dismissedAdvice(): Set<string> {
  return read();
}

export function dismissAdvice(id: string): Set<string> {
  const s = read();
  s.add(id);
  return write(s);
}

export function restoreAdvice(id: string): Set<string> {
  const s = read();
  s.delete(id);
  return write(s);
}
