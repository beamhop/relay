<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** API tokens (§6.4): list with plain scopes, swipe or tap to revoke (undo toast), create via the generated form. */
  import { onMount } from 'svelte';
  import { app } from '$lib/stores/app.svelte';
  import { flow, query, runNow } from '$lib/stores/actions.svelte';
  import { ago } from '$lib/utils';
  import SwipeRow from '$lib/components/SwipeRow.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Badge from '$lib/components/ui/badge.svelte';
  import { daysLeft, scopeLabel, sortTokens, tokenState, type TokenInfo } from './security';
  import { m } from '$lib/paraglide/messages.js';

  let tokens = $state<TokenInfo[] | null>(null);

  async function load() {
    const r = await query<{ tokens: TokenInfo[] }>('tokens.list');
    tokens = r ? sortTokens(r.tokens) : [];
  }
  onMount(load);

  function create() {
    const def = app.action('tokens.create');
    if (def) void flow.start(def, {}, { form: true, onDone: () => void load(), onUndo: () => void load() });
  }

  async function revoke(t: TokenInfo) {
    const r = await runNow('tokens.revoke', { id: t.id }, { afterUndo: () => void load() });
    if (r) await load();
  }

  const canRevoke = $derived(app.hasAction('tokens.revoke'));
  const mine = (t: TokenInfo) => !t.adminId || t.adminId === app.me?.id;
</script>

<section class="rounded-xl border p-4" data-testid="tokens">
  <h2 class="text-sm font-medium">{m.security_tokens()}</h2>
  <p class="mt-1 text-sm text-muted-foreground">{m.security_tokens_desc()}</p>

  {#if tokens && tokens.length}
    <ul class="mt-3 divide-y overflow-hidden rounded-lg border" data-testid="token-list">
      {#each tokens as t (t.id)}
        {@const state = tokenState(t)}
        <li>
          <SwipeRow testid="token-row" right={canRevoke ? [{ id: 'revoke', label: m.ppl_sec_token_revoke(), tone: 'critical', run: () => void revoke(t) }] : []}>
            <div class="flex items-start gap-3 p-3">
              <div class="min-w-0 flex-1">
                <p class="flex items-center gap-2 text-sm font-medium">
                  <span class="truncate">{t.name}</span>
                  {#if state === 'expired'}<Badge tone="critical">{m.ppl_sec_token_expired()}</Badge>{:else if state === 'soon'}<Badge tone="warn">{m.ppl_sec_token_soon()}</Badge>{/if}
                </p>
                <p class="text-xs text-muted-foreground">
                  {m.ppl_sec_token_can()} {t.scopes.map(scopeLabel).join(', ')}
                </p>
                <p class="text-xs text-muted-foreground">
                  {m.ppl_sec_token_created({ when: ago(t.createdAt) })} · {t.lastUsedAt ? m.ppl_sec_token_used({ when: ago(t.lastUsedAt) }) : m.ppl_sec_token_never()}
                  {#if state !== 'expired'}· {m.ppl_sec_token_days({ count: daysLeft(t.expiresAt) })}{/if}
                  {#if !mine(t) && t.adminName}· {m.ppl_sec_token_by({ name: t.adminName })}{/if}
                </p>
                <ItemLens
                  lines={[`id ${t.id}`, `scopes ${t.scopes.join(' ')}`, `expiresAt ${t.expiresAt}`, ...(t.adminId ? [`admin ${t.adminId}`] : [])]}
                />
              </div>
              {#if canRevoke}
                <Button size="sm" variant="ghost" class="text-destructive" onclick={() => void revoke(t)} data-testid="token-revoke">
                  {m.ppl_sec_token_revoke()}
                </Button>
              {/if}
            </div>
          </SwipeRow>
        </li>
      {/each}
    </ul>
    {#if canRevoke}<p class="mt-2 text-center text-[11px] text-muted-foreground md:hidden">{m.ppl_sec_swipe_hint()}</p>{/if}
  {:else if tokens}
    <p class="mt-3 text-xs text-muted-foreground">{m.ppl_sec_tokens_empty()}</p>
  {/if}

  {#if app.hasAction('tokens.create')}
    <Button size="sm" variant="secondary" class="mt-3" onclick={create} data-testid="token-create">{m.security_new_token()}</Button>
  {/if}
</section>
