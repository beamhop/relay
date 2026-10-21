<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /**
   * Settings › Network access (§12.10): which networks may open the admin app
   * and each relay, trusting the proxy in front, company devices only (client
   * certificates), a company sign-in proxy (zero trust) and private mode.
   * Generated from the live config schema; saved with the standard settings
   * flow (propose → plain diff → apply → undo). Detail sits in "Advanced".
   */
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import type { JsonSchema, NodeConfig } from '$lib/api/types';
  import type { FieldSpec } from '$lib/forms/json-schema';
  import { getIn } from '$lib/forms/json-schema';
  import { app } from '$lib/stores/app.svelte';
  import { configFlow } from '$lib/stores/config.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import GeneratedForm from '$lib/components/forms/GeneratedForm.svelte';
  import ErrorPanel from '$lib/components/ErrorPanel.svelte';
  import ItemLens from '$lib/components/ItemLens.svelte';
  import Sheet from '$lib/components/Sheet.svelte';
  import Button from '$lib/components/ui/button.svelte';
  import Skeleton from '$lib/components/ui/skeleton.svelte';
  import { query } from '$lib/stores/actions.svelte';
  import {
    ADVANCED,
    NET,
    SIMPLE,
    type GroupRef,
    fieldsFor,
    groupRefs,
    hasNetworkSchema,
    initialValues,
    outboundFields,
    outboundLens,
    patchFor,
  } from './network.ts';

  interface Loaded {
    doc: NodeConfig;
    simple: FieldSpec[];
    advanced: FieldSpec[];
    outbound: FieldSpec[];
    initial: Record<string, unknown>;
  }

  let data = $state<Loaded | null>(null);
  let unavailable = $state(false);
  let error = $state<unknown>(null);
  let version = $state(0);
  let advancedOpen = $state(false);
  /** Live values of the team-groups form (saved together with the Advanced form). */
  let outboundValues: Record<string, unknown> = {};

  async function load() {
    error = null;
    try {
      const [cfg, schema, groups] = await Promise.all([
        app.api.config(),
        app.api.configSchema(false),
        query<GroupRef[]>('groups.list'),
      ]);
      const s = schema as JsonSchema;
      if (!hasNetworkSchema(s)) {
        unavailable = true;
        return;
      }
      const doc = cfg.config;
      const relays = (doc.relays ?? []).map((r) => ({ id: r.id, name: r.info?.name }));
      const simple = fieldsFor(s, SIMPLE, relays, app.relayId);
      const advanced = fieldsFor(s, ADVANCED, relays, app.relayId);
      const outbound = outboundFields(s, groupRefs(doc, Array.isArray(groups) ? groups : []));
      outboundValues = {};
      data = {
        doc,
        simple,
        advanced,
        outbound,
        initial: initialValues(doc, [...simple, ...advanced, ...outbound]),
      };
      version++;
    } catch (err) {
      error = err;
    }
  }

  let loadedFor: string | null | undefined;
  $effect(() => {
    const key = app.relayId;
    if (key === loadedFor) return;
    loadedFor = key;
    data = null;
    void load();
  });

  async function save(fields: FieldSpec[], values: Record<string, unknown>) {
    if (!data) return;
    const patch = patchFor(data.doc, fields, values);
    if (!patch.length) {
      toasts.show({ message: 'Nothing changed', kind: 'info' });
      return;
    }
    const ok = await configFlow.propose(
      { patch, summary: 'Changed network access' },
      { relay: false, onApplied: () => load() },
    );
    if (ok) advancedOpen = false;
  }

  /** Network controls behind a proxy only work when the proxy is trusted (health check `proxy-trust`). */
  const proxyWarning = $derived.by(() => {
    if (!data) return false;
    const net = getIn(data.doc, [...NET]) as
      | {
          allowlist?: { admin?: string[]; relays?: Record<string, string[]> };
          denylist?: { all?: string[]; relays?: Record<string, string[]> };
          mtls?: { enabled?: boolean };
        }
      | undefined;
    const needs =
      (net?.allowlist?.admin?.length ?? 0) > 0 ||
      (net?.denylist?.all?.length ?? 0) > 0 ||
      Object.values(net?.denylist?.relays ?? {}).some((l) => l.length > 0) ||
      Object.values(net?.allowlist?.relays ?? {}).some((l) => l.length > 0) ||
      !!net?.mtls?.enabled;
    return needs && !getIn(data.doc, ['node', 'trustProxy']);
  });
</script>

<div class="md:max-w-xl" data-testid="network-access">
  <p class="text-sm text-muted-foreground">Decide which networks and devices can reach the admin app and your relays.</p>

  {#if unavailable}
    <p class="mt-4 text-sm text-muted-foreground">Network access settings are not available on this server.</p>
  {:else if error}
    <div class="mt-4"><ErrorPanel {error} reset={load} /></div>
  {:else if !data}
    <div class="mt-4 space-y-4">{#each SIMPLE as k (k)}<Skeleton class="h-14 w-full" />{/each}</div>
  {:else}
    {#if proxyWarning}
      <div class="mt-4 flex items-start gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm" data-testid="proxy-warning">
        <TriangleAlert class="mt-0.5 size-4 shrink-0 text-warning" />
        <div class="min-w-0">
          <p>Your limits see the proxy’s address, not your users’. Turn on “My server is behind a proxy” if it is.</p>
          <ItemLens lines={['node.trustProxy=false: X-Forwarded-For / client-cert headers from the proxy are ignored (health check enterprise-network.proxy-trust)']} />
        </div>
      </div>
    {/if}
    {#key version}
      <div class="mt-4 divide-y rounded-xl border px-4" data-testid="network-simple">
        <GeneratedForm id="network-simple" fields={data.simple} initial={data.initial} doc={data.doc} onsubmit={(v) => save(data!.simple, v)} />
      </div>
    {/key}
    <div class="mt-4 flex gap-2">
      {#if data.advanced.length}
        <Button variant="secondary" class="flex-1" onclick={() => (advancedOpen = true)} data-testid="network-advanced-open">Advanced</Button>
      {/if}
      <Button class="flex-1" type="submit" form="network-simple" disabled={configFlow.busy} data-testid="network-save">Save</Button>
    </div>
  {/if}
</div>

{#if data}
  <Sheet bind:open={advancedOpen} title="Network access · Advanced" description="Device certificates, sign-in proxy details, other relays and team groups.">
    {#key version}
      <GeneratedForm
      id="network-advanced"
      fields={data.advanced}
      initial={data.initial}
      doc={data.doc}
      onsubmit={(v) => save([...data!.advanced, ...data!.outbound], { ...data!.initial, ...outboundValues, ...v })}
    />
    {#if data.outbound.length}
      <section class="mt-6 border-t pt-4" data-testid="network-outbound">
        <h3 class="text-sm font-semibold">Team groups</h3>
        <p class="mt-1 text-sm text-muted-foreground">Messages in these groups stay on your company’s relays.</p>
        <ItemLens lines={outboundLens(data.doc)} />
        <GeneratedForm
          id="network-outbound"
          fields={data.outbound}
          initial={data.initial}
          doc={data.doc}
          onchange={(v) => (outboundValues = v)}
          onsubmit={() => {}}
        />
      </section>
    {/if}
    {/key}
    {#snippet footer()}
      <Button class="w-full" type="submit" form="network-advanced">Save</Button>
    {/snippet}
  </Sheet>
{/if}
