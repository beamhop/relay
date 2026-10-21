// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KeyWrapper } from '@beamhop/core';

/** A key-encryption key. `id` identifies the key (not the provider) so rotation can tell KEKs apart. */
export interface KekProvider extends KeyWrapper {
  readonly id: string;
}

/** Thrown for HTTP failures talking to a KMS; never includes secrets. */
export class KmsError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
  ) {
    super(`${provider}: ${message}`);
  }
}

export async function expectOk(provider: string, res: Response, what: string): Promise<unknown> {
  const text = await res.text();
  if (!res.ok) {
    let detail = '';
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const e = j.error ?? j.errors ?? j.message ?? j.__type;
      detail = typeof e === 'string' ? e : JSON.stringify(e).slice(0, 200);
    } catch {
      detail = text.slice(0, 200);
    }
    throw new KmsError(
      provider,
      res.status,
      `${what} failed (HTTP ${res.status}) ${detail}`.trim(),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new KmsError(provider, res.status, `${what} returned invalid JSON`);
  }
}

/** Access token cache for OAuth2 flows. */
export class TokenCache {
  private token: { value: string; exp: number } | null = null;
  private pending: Promise<string> | null = null;
  constructor(
    private readonly nowMs: () => number,
    private readonly fetchToken: () => Promise<{ token: string; expiresIn: number }>,
  ) {}

  get(): Promise<string> {
    if (this.token && this.token.exp - 60_000 > this.nowMs())
      return Promise.resolve(this.token.value);
    if (!this.pending) {
      this.pending = this.fetchToken()
        .then(({ token, expiresIn }) => {
          this.token = { value: token, exp: this.nowMs() + expiresIn * 1000 };
          return token;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    return this.pending;
  }

  clear(): void {
    this.token = null;
  }
}
