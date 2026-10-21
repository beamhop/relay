<script lang="ts">
  /**
   * Company sign-in (enterprise identity module, §12): turn the feature on
   * (preview → apply, no reload), pick Google / Microsoft / Other, follow the
   * steps with copy buttons (redirect address, SCIM address and token), paste
   * the app keys, test the connection, then decide what each company group may
   * do. Every field and action degrades gracefully on servers without it.
   */
  import { onMount } from 'svelte';
  import Building2 from '@lucide/svelte/icons/building-2';
  import Copy from '@lucide/svelte/icons/copy';
  import Check from '@lucide/svelte/icons/check';
  import X from '@lucide/svelte/icons/x';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import Plus from '@lucide/svelte/icons/plus';
  import { app } from '$lib/stores/app.svelte';
  import { asApiError, flow, query, withContext } from '$lib/stores/actions.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { fieldsFromSchema } from '$lib/forms/json-schema';
  import type { CatalogAction } from '$lib/api/types';
  import { cn } from '$lib/utils';
  import Button from '../ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { compact = false }: { compact?: boolean } = $props();

  const MODULE = 'enterprise-identity';
  type Choice = 'google' | 'microsoft' | 'other';

  interface Setup {
    /** Provider id on the server (used by the connection test and group rules). */
    idp?: string;
    steps: Array<{ title?: string; body: string; copy: Array<[string, string]> }>;
    redirectUris: string[];
    signInUrl?: string;
    scimUrl?: string;
    scimToken?: string;
    scimTokenLast4?: string;
  }

  let moduleOn = $state<boolean | null>(null);
  let choice = $state<Choice | null>(null);
  let setup = $state<Setup | null>(null);
  let setupError = $state<string | null>(null);
  let loadingSetup = $state(false);
  let clientId = $state('');
  let clientSecret = $state('');
  let tenant = $state('');
  let domain = $state('');
  let issuer = $state('');
  let connected = $state(false);
  let testing = $state(false);
  let test = $state<{
    ok: boolean;
    message: string;
    checks: Array<{ name: string; ok: boolean; message: string; technical?: string }>;
  } | null>(null);
  let mappings = $state<Array<Record<string, unknown>>>([]);

  const enabled = $derived(app.hasAction('enterprise.connect-idp') || moduleOn === true);
  const connect = $derived(app.action('enterprise.connect-idp'));

  async function loadModule() {
    const r = await query<{ modules: Array<{ id: string; enabled: boolean }> }>('modules.list', {});
    moduleOn = r ? !!r.modules.find((x) => x.id === MODULE)?.enabled : null;
  }

  async function loadMappings() {
    const r = await query<{ mappings?: Array<Record<string, unknown>>; groups?: Array<Record<string, unknown>> }>(
      'enterprise.list-mappings',
      {},
    );
    mappings = r?.mappings ?? r?.groups ?? [];
  }

  onMount(() => {
    void loadModule();
    void loadMappings();
  });

  function turnOn() {
    const def = app.action('modules.enable');
    if (!def) return;
    void flow.start(def, { id: MODULE }, {
      onDone: async () => {
        await app.refreshCatalog();
        await loadModule();
        void loadMappings();
      },
      onUndo: async () => {
        await app.refreshCatalog();
        await loadModule();
      },
    });
  }

  /** Only send what the server's action accepts (older servers ignore nothing gracefully). */
  function accepted(def: CatalogAction | undefined, input: Record<string, unknown>): Record<string, unknown> {
    const props = def?.inputSchema?.properties;
    if (!props) return input;
    return Object.fromEntries(Object.entries(input).filter(([k, v]) => k in props && v !== '' && v !== undefined));
  }

  /** Map our three choices onto the provider values the server knows. */
  function providerValue(c: Choice): string {
    const values = (connect?.inputSchema?.properties?.provider?.enum ?? []) as string[];
    const want = c === 'google' ? /google/i : c === 'microsoft' ? /microsoft|entra|azure/i : /oidc|other|generic|saml/i;
    return values.find((v) => want.test(v)) ?? (c === 'other' ? 'oidc' : c);
  }

  function asSetup(o: Record<string, unknown>): Setup {
    const steps = (Array.isArray(o.steps) ? o.steps : []).map((s) => {
      if (typeof s === 'string') return { body: s, copy: [] as Array<[string, string]> };
      const st = s as { title?: string; body?: string; text?: string; copy?: Record<string, string> };
      return {
        ...(st.title ? { title: st.title } : {}),
        body: String(st.body ?? st.text ?? ''),
        copy: Object.entries(st.copy ?? {}).map(([k, v]) => [k, String(v)] as [string, string]),
      };
    });
    const v = (o.values ?? {}) as Record<string, string | undefined>;
    const scim = (o.scim ?? {}) as { url?: string; token?: string };
    const redirect = v.redirectUri ?? (o.redirectUri as string | undefined);
    const uris = Array.isArray(o.redirectUris) ? o.redirectUris.map(String) : redirect ? [redirect] : [];
    const out: Setup = { steps, redirectUris: uris };
    if (typeof o.idp === 'string') out.idp = o.idp;
    const scimUrl = v.scimUrl ?? scim.url ?? (o.scimUrl as string | undefined);
    const scimToken = v.scimToken ?? scim.token ?? (o.scimToken as string | undefined);
    if (v.signInUrl) out.signInUrl = v.signInUrl;
    if (scimUrl) out.scimUrl = scimUrl;
    if (scimToken) out.scimToken = scimToken;
    if (v.scimTokenLast4) out.scimTokenLast4 = v.scimTokenLast4;
    return out;
  }

  /** Server id of the chosen provider (as `enterprise.connect-idp` names it). */
  const idpId = $derived(
    setup?.idp ?? (choice === 'microsoft' ? 'entra' : choice === 'google' ? 'google' : choice ? 'oidc' : undefined),
  );

  async function pick(c: Choice) {
    choice = c;
    setup = null;
    setupError = null;
    test = null;
    if (!connect) return;
    loadingSetup = true;
    try {
      const input = accepted(connect, withContext(connect.id, { provider: providerValue(c) }));
      const r = await app.api.run<Record<string, unknown>>(connect.id, input, connect.scope);
      setup = asSetup(r.output ?? {});
      if (r.output?.connected || r.output?.applied) connected = true;
    } catch (err) {
      setupError = asApiError(err).message;
    } finally {
      loadingSetup = false;
    }
  }

  function saveKeys() {
    if (!connect || !choice) return;
    const input = accepted(
      connect,
      withContext(connect.id, {
        provider: providerValue(choice),
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        ...(choice === 'microsoft' ? { tenant: tenant.trim() } : {}),
        ...(choice === 'google' ? { domain: domain.trim() } : {}),
        ...(choice === 'other' ? { issuer: issuer.trim(), domain: domain.trim() } : {}),
      }),
    );
    void flow.start(connect, input, {
      onDone: () => {
        connected = true;
        clientSecret = '';
      },
    });
  }

  async function testConnection() {
    const def = app.action('enterprise.test-connection');
    if (!def) return;
    testing = true;
    try {
      const r = await app.api.run<{
        ok?: boolean;
        message?: string;
        checks?: Array<{ name: string; ok: boolean; message: string; technical?: string }>;
      }>(def.id, accepted(def, { idp: idpId ?? '*' }), def.scope);
      test = { ok: r.output?.ok !== false, message: r.output?.message ?? r.summary, checks: r.output?.checks ?? [] };
    } catch (err) {
      test = { ok: false, message: asApiError(err).message, checks: [] };
    } finally {
      testing = false;
    }
  }

  function addGroup() {
    const def = app.action('enterprise.map-group');
    if (!def) return;
    const input = accepted(def, {
      idp: idpId ?? '*',
      relays: app.relayId ? [{ relayId: app.relayId, access: 'write' }] : [],
    });
    void flow.start(def, input, { form: true, onDone: () => void loadMappings(), onUndo: () => void loadMappings() });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toasts.show({ message: m.common_copied(), kind: 'info' });
    } catch {
      toasts.error(m.common_copy_failed());
    }
  }

  /** Plain labels for mapping values (from the action's `x-enumLabels` when published). */
  const mapFields = $derived(fieldsFromSchema(app.action('enterprise.map-group')?.inputSchema ?? {}));
  function label(key: string, v: unknown): string {
    if (v === undefined || v === null || v === '') return '—';
    if (key === 'relays' && Array.isArray(v))
      return v.length
        ? v
            .map((r: { relayId?: string; access?: string }) =>
              r.access === 'read' ? m.company_reads({ relay: String(r.relayId) }) : m.company_posts({ relay: String(r.relayId) }),
            )
            .join(', ')
        : m.company_no_access();
    const f = mapFields.find((x) => x.name === key);
    return f?.options?.find((o) => o.value === v)?.label ?? String(v);
  }
  const COLUMNS = [
    { key: 'group', label: () => m.company_col_group() },
    { key: 'relays', label: () => m.company_col_access() },
    { key: 'tier', label: () => m.company_col_tier() },
    { key: 'adminRole', label: () => m.company_col_role() },
    { key: 'keyModel', label: () => m.company_col_keys() },
  ];
  const providers: Array<{ id: Choice; label: () => string; hint: () => string }> = [
    { id: 'google', label: () => m.company_google(), hint: () => m.company_google_hint() },
    { id: 'microsoft', label: () => m.company_microsoft(), hint: () => m.company_microsoft_hint() },
    { id: 'other', label: () => m.company_other(), hint: () => m.company_other_hint() },
  ];
</script>

<div class="space-y-4" data-testid="company-signin" data-enabled={enabled}>
  {#if !enabled}
    <section class="rounded-xl border p-4" data-testid="company-off">
      <div class="flex items-start gap-3">
        <Building2 class="mt-0.5 size-5 shrink-0 text-primary" />
        <div class="min-w-0 flex-1">
          <h2 class="text-sm font-medium">{m.company_turn_on_title()}</h2>
          <p class="mt-1 text-sm text-muted-foreground">{m.company_turn_on_body()}</p>
          {#if app.hasAction('modules.enable')}
            <Button size="sm" class="mt-3" onclick={turnOn} data-testid="company-enable">{m.company_turn_on()}</Button>
          {:else}
            <p class="mt-2 text-xs text-muted-foreground">{m.company_cannot_enable()}</p>
          {/if}
        </div>
      </div>
    </section>
  {:else}
    <section class="rounded-xl border p-4">
      <h2 class="text-sm font-medium">{m.company_step_provider()}</h2>
      <div class={cn('mt-3 grid gap-2', !compact && 'sm:grid-cols-3')} role="radiogroup" aria-label={m.company_step_provider()}>
        {#each providers as p (p.id)}
          <button
            role="radio"
            aria-checked={choice === p.id}
            class={cn('rounded-xl border p-3 text-left hover:bg-muted/60', choice === p.id && 'border-primary bg-accent/40')}
            onclick={() => pick(p.id)}
            data-testid={`provider-${p.id}`}
          >
            <span class="block text-sm font-medium">{p.label()}</span>
            <span class="block text-xs text-muted-foreground">{p.hint()}</span>
          </button>
        {/each}
      </div>
    </section>

    {#if choice}
      <section class="rounded-xl border p-4" data-testid="company-steps">
        <h2 class="text-sm font-medium">{m.company_step_setup()}</h2>
        {#if loadingSetup}
          <p class="mt-2 flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle class="size-4 animate-spin" />{m.common_working()}</p>
        {:else if setupError}
          <p class="mt-2 text-sm text-destructive" role="alert">{setupError}</p>
        {:else if setup}
          {#if setup.steps.length}
            <ol class="mt-2 list-decimal space-y-1.5 pl-5 text-sm">
              {#each setup.steps as s, i (i)}
                <li>
                  {#if s.title}<span class="font-medium">{s.title}. </span>{/if}<span class="text-muted-foreground">{s.body}</span>
                  {#each s.copy as [k, v] (k)}
                    {#if !setup.redirectUris.includes(v) && v !== setup.scimUrl && v !== setup.scimToken}
                      <span class="mt-1 flex items-center gap-2 rounded-md border px-2 py-1">
                        <span class="min-w-0 flex-1"><span class="block text-[11px] text-muted-foreground">{k}</span><span class="block truncate font-mono text-xs">{v}</span></span>
                        <Button size="icon" variant="ghost" class="size-7" aria-label={m.company_copy({ what: k })} onclick={() => copy(v)}><Copy class="size-3.5" /></Button>
                      </span>
                    {/if}
                  {/each}
                </li>
              {/each}
            </ol>
          {/if}
          {#each setup.redirectUris as uri (uri)}
            <div class="mt-3 flex items-center gap-2 rounded-lg border p-2.5">
              <div class="min-w-0 flex-1">
                <p class="text-xs text-muted-foreground">{m.company_redirect()}</p>
                <p class="truncate font-mono text-xs" data-testid="redirect-uri">{uri}</p>
              </div>
              <Button size="icon" variant="ghost" aria-label={m.company_copy_redirect()} onclick={() => copy(uri)} data-testid="copy-redirect"><Copy class="size-4" /></Button>
            </div>
          {/each}
          {#if setup.scimUrl}
            <div class="mt-2 flex items-center gap-2 rounded-lg border p-2.5">
              <div class="min-w-0 flex-1">
                <p class="text-xs text-muted-foreground">{m.company_scim_url()}</p>
                <p class="truncate font-mono text-xs" data-testid="scim-url">{setup.scimUrl}</p>
              </div>
              <Button size="icon" variant="ghost" aria-label={m.company_copy_scim_url()} onclick={() => copy(setup!.scimUrl!)}><Copy class="size-4" /></Button>
            </div>
          {/if}
          {#if !setup.scimToken && setup.scimTokenLast4}
            <p class="mt-2 text-xs text-muted-foreground">{m.company_scim_existing({ last4: setup.scimTokenLast4 })}</p>
          {/if}
          {#if setup.scimToken}
            <div class="mt-2 flex items-center gap-2 rounded-lg border p-2.5">
              <div class="min-w-0 flex-1">
                <p class="text-xs text-muted-foreground">{m.company_scim_token()}</p>
                <p class="truncate font-mono text-xs" data-testid="scim-token">{setup.scimToken}</p>
                <p class="text-[11px] text-warning">{m.action_shown_once()}</p>
              </div>
              <Button size="icon" variant="ghost" aria-label={m.company_copy_scim_token()} onclick={() => copy(setup!.scimToken!)}><Copy class="size-4" /></Button>
            </div>
          {/if}
        {/if}

        <form
          class="mt-4 space-y-2 border-t pt-4"
          autocomplete="off"
          onsubmit={(e) => {
            e.preventDefault();
            saveKeys();
          }}
        >
          <h3 class="text-sm font-medium">{m.company_step_keys()}</h3>
          <input class="h-10 w-full rounded-lg border bg-background px-3 text-sm" placeholder={m.company_client_id()} aria-label={m.company_client_id()} bind:value={clientId} data-testid="client-id" required />
          <input type="password" class="h-10 w-full rounded-lg border bg-background px-3 text-sm" placeholder={m.company_client_secret()} aria-label={m.company_client_secret()} bind:value={clientSecret} data-testid="client-secret" autocomplete="new-password" />
          {#if choice === 'microsoft'}
            <input class="h-10 w-full rounded-lg border bg-background px-3 text-sm" placeholder={m.company_tenant()} aria-label={m.company_tenant()} bind:value={tenant} data-testid="tenant" />
          {/if}
          {#if choice === 'other'}
            <input class="h-10 w-full rounded-lg border bg-background px-3 text-sm" placeholder={m.company_issuer()} aria-label={m.company_issuer()} bind:value={issuer} data-testid="issuer" inputmode="url" />
          {/if}
          {#if choice !== 'microsoft'}
            <input class="h-10 w-full rounded-lg border bg-background px-3 text-sm" placeholder={m.company_domain()} aria-label={m.company_domain()} bind:value={domain} data-testid="domain" />
          {/if}
          <Button type="submit" class="w-full" disabled={!clientId.trim() || !connect} data-testid="company-connect">{m.company_connect()}</Button>
        </form>
      </section>
    {/if}

    {#if app.hasAction('enterprise.test-connection')}
      <section class="rounded-xl border p-4">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 text-sm font-medium">{m.company_step_test()}</h2>
          <Button size="sm" variant="secondary" disabled={testing} onclick={testConnection} data-testid="company-test">
            {#if testing}<LoaderCircle class="size-4 animate-spin" />{/if}{m.company_test()}
          </Button>
        </div>
        {#if test}
          <p class={cn('mt-2 flex items-center gap-2 text-sm', test.ok ? 'text-success' : 'text-destructive')} data-testid="company-test-result" data-ok={test.ok}>
            {#if test.ok}<Check class="size-4" />{:else}<X class="size-4" />{/if}{test.message}
          </p>
          {#if test.checks.length}
            <ul class="mt-2 space-y-1 text-sm" data-testid="company-test-checks">
              {#each test.checks as c (c.name)}
                <li class="flex items-start gap-2">
                  {#if c.ok}<Check class="mt-0.5 size-3.5 shrink-0 text-success" />{:else}<X class="mt-0.5 size-3.5 shrink-0 text-destructive" />{/if}
                  <span>{c.message}{#if prefs.lens && c.technical}<span class="block font-mono text-[10px] text-muted-foreground" data-lens>{c.technical}</span>{/if}</span>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if !connected}
          <p class="mt-1 text-xs text-muted-foreground">{m.company_test_hint()}</p>
        {/if}
      </section>
    {/if}

    {#if app.hasAction('enterprise.list-mappings') || app.hasAction('enterprise.map-group')}
      <section class="rounded-xl border p-4" data-testid="company-mappings">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 text-sm font-medium">{m.company_step_groups()}</h2>
          {#if app.hasAction('enterprise.map-group')}
            <Button size="sm" variant="secondary" onclick={addGroup} data-testid="company-add-group"><Plus class="size-4" />{m.company_add_group()}</Button>
          {/if}
        </div>
        <p class="mt-1 text-xs text-muted-foreground">{m.company_groups_desc()}</p>
        {#if mappings.length}
          <div class="mt-3 overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead class="text-xs text-muted-foreground">
                <tr>{#each COLUMNS as c (c.key)}<th class="px-2 py-1.5 font-medium">{c.label()}</th>{/each}</tr>
              </thead>
              <tbody class="divide-y">
                {#each mappings as row, i (i)}
                  <tr data-testid="mapping-row">
                    {#each COLUMNS as c (c.key)}
                      <td class="px-2 py-2">{label(c.key, row[c.key] ?? (c.key === 'adminRole' ? row.role : undefined))}{#if prefs.lens && c.key !== 'group' && row[c.key] !== undefined}<span class="block font-mono text-[10px] text-muted-foreground" data-lens>{JSON.stringify(row[c.key])}</span>{/if}</td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="mt-3 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">{m.company_groups_empty()}</p>
        {/if}
      </section>
    {/if}
  {/if}
</div>
