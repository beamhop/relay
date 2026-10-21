// SPDX-License-Identifier: AGPL-3.0-or-later
import { base } from '$app/paths';

/** App-internal link (prefixed with the `/admin` base path). */
export function to(path: string): string {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

/** Strip the base path from a pathname. */
export function local(pathname: string): string {
  return pathname.startsWith(base) ? pathname.slice(base.length) || '/' : pathname;
}
