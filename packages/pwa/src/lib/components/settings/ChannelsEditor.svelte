<script lang="ts">
  /**
   * Where alerts go (§8): a list of channels with "Send test", and an
   * add-channel flow (type picker → only the fields that type needs). Changes
   * go through the standard propose → diff → apply → undo.
   */
  import Plus from '@lucide/svelte/icons/plus';
  import Smartphone from '@lucide/svelte/icons/smartphone';
  import MessageCircle from '@lucide/svelte/icons/message-circle';
  import Send from '@lucide/svelte/icons/send';
  import Hash from '@lucide/svelte/icons/hash';
  import Mail from '@lucide/svelte/icons/mail';
  import Slack from '@lucide/svelte/icons/slack';
  import Trash2 from '@lucide/svelte/icons/trash-2';
  import {
    type AlertChannel,
    type ChannelType,
    CHANNEL_TYPES,
    type FieldError,
    addChannelPatch,
    buildChannel,
    channelTarget,
    fieldsFor,
    removeChannelPatch,
  } from '$lib/alert-channels';
  import { app } from '$lib/stores/app.svelte';
  import { configFlow } from '$lib/stores/config.svelte';
  import { asApiError, runNow } from '$lib/stores/actions.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { prefs } from '$lib/stores/prefs.svelte';
  import { enablePush } from '$lib/push';
  import Sheet from '../Sheet.svelte';
  import Button from '../ui/button.svelte';
  import { m } from '$lib/paraglide/messages.js';

  let { channels, onchanged }: { channels: AlertChannel[]; onchanged: () => void } = $props();

  const TEST = 'alerts.test-channel';
  const canTest = $derived(app.hasAction(TEST));
  const canEdit = $derived(app.can('config.write', false));

  let adding = $state(false);
  let type = $state<ChannelType | null>(null);
  let values = $state<Record<string, string>>({});
  let errors = $state<Record<string, FieldError>>({});
  let testing = $state<string | null>(null);

  const icons = {
    webpush: Smartphone,
    'nostr-dm': MessageCircle,
    telegram: Send,
    discord: Hash,
    slack: Slack,
    email: Mail,
  } as const;

  const typeLabel = (t: string): string =>
    ({
      webpush: m.channel_type_webpush(),
      'nostr-dm': m.channel_type_nostr_dm(),
      telegram: m.channel_type_telegram(),
      discord: m.channel_type_discord(),
      slack: m.channel_type_slack(),
      email: m.channel_type_email(),
    })[t] ?? t;

  const typeHelp = (t: ChannelType): string =>
    ({
      webpush: m.channel_help_webpush(),
      'nostr-dm': m.channel_help_nostr_dm(),
      telegram: m.channel_help_telegram(),
      discord: m.channel_help_discord(),
      slack: m.channel_help_slack(),
      email: m.channel_help_email(),
    })[t];

  const fieldLabel = (k: string): string =>
    ({
      pubkey: m.channel_field_pubkey(),
      botToken: m.channel_field_bot_token(),
      chatId: m.channel_field_chat_id(),
      webhookUrl: m.channel_field_webhook_url(),
      to: m.channel_field_to(),
      smtpUrl: m.channel_field_smtp_url(),
    })[k] ?? k;

  const errorText = (e: FieldError): string =>
    ({
      required: m.channel_err_required(),
      pubkey: m.channel_err_pubkey(),
      url: m.channel_err_url(),
      email: m.channel_err_email(),
      smtp: m.channel_err_smtp(),
      'telegram-token': m.channel_err_telegram_token(),
    })[e];

  function startAdd() {
    type = null;
    values = {};
    errors = {};
    adding = true;
  }

  function pick(t: ChannelType) {
    type = t;
    values = {};
    errors = {};
  }

  async function decodeNpub(): Promise<(npub: string) => string | null> {
    const { decode } = await import('nostr-tools/nip19');
    return (npub) => {
      try {
        const r = decode(npub);
        return r.type === 'npub' ? (r.data as string) : null;
      } catch {
        return null;
      }
    };
  }

  async function review() {
    if (!type) return;
    const decoder = type === 'nostr-dm' && values.pubkey?.trim().startsWith('npub1') ? await decodeNpub() : undefined;
    const r = buildChannel(type, values, channels, decoder);
    errors = r.errors;
    if (!r.channel) return;
    if (type === 'webpush' && channels.some((c) => c.type === 'webpush')) {
      // The phone-push channel exists already: just subscribe this device.
      adding = false;
      await subscribeDevice();
      return;
    }
    const channel = r.channel;
    adding = false;
    await configFlow.propose(
      { patch: addChannelPatch(channel, channels.length), summary: m.channel_add_summary({ type: typeLabel(channel.type) }) },
      {
        relay: false,
        onApplied: () => {
          onchanged();
          if (channel.type === 'webpush') void subscribeDevice();
        },
      },
    );
  }

  async function subscribeDevice() {
    try {
      const r = await enablePush(app.api, app.catalog);
      if (r === 'enabled') toasts.success(m.push_enabled());
      else
        toasts.show({
          message: r === 'denied' ? m.push_denied() : r === 'unsupported' ? m.push_unsupported() : m.push_unavailable(),
          kind: 'info',
        });
    } catch (err) {
      toasts.error(asApiError(err).message);
    }
  }

  async function remove(i: number) {
    const c = channels[i];
    if (!c) return;
    await configFlow.propose(
      { patch: removeChannelPatch(i), summary: m.channel_remove_summary({ type: typeLabel(c.type) }) },
      { relay: false, onApplied: () => onchanged() },
    );
  }

  async function test(c: AlertChannel) {
    testing = c.id;
    try {
      await runNow(TEST, { channelId: c.id });
    } finally {
      testing = null;
    }
  }
</script>

<section class="rounded-xl border" data-testid="alert-channels" aria-labelledby="channels-title">
  <div class="flex items-center justify-between gap-2 px-4 pt-3">
    <h2 id="channels-title" class="text-sm font-medium">{m.channels_title()}</h2>
    {#if canEdit}
      <Button size="sm" variant="secondary" onclick={startAdd} data-testid="channel-add"><Plus class="size-4" />{m.channels_add()}</Button>
    {/if}
  </div>
  {#if channels.length === 0}
    <p class="px-4 py-3 text-sm text-muted-foreground" data-testid="channels-empty">{m.channels_empty()}</p>
  {:else}
    <ul class="divide-y">
      {#each channels as c, i (c.id)}
        {@const Icon = icons[c.type as ChannelType] ?? Send}
        <li class="flex items-center gap-3 px-4 py-3" data-testid="channel-row" data-channel={c.id}>
          <Icon class="size-4 shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <p class="text-sm">{typeLabel(c.type)}</p>
            <p class="truncate text-xs text-muted-foreground">
              {channelTarget(c) || (c.type === 'webpush' ? m.channel_help_webpush_short() : '')}
              {#if prefs.lens}<span class="font-mono" data-lens> · {c.type} · id={c.id}</span>{/if}
            </p>
          </div>
          {#if canTest}
            <Button size="sm" variant="ghost" disabled={testing === c.id} onclick={() => test(c)} data-testid="channel-test">
              {testing === c.id ? m.common_working() : m.channels_test()}
            </Button>
          {/if}
          {#if canEdit}
            <Button size="sm" variant="ghost" aria-label={m.channels_remove({ type: typeLabel(c.type) })} onclick={() => remove(i)}>
              <Trash2 class="size-4" />
            </Button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<Sheet
  bind:open={adding}
  title={type ? typeLabel(type) : m.channels_add_title()}
  description={type ? typeHelp(type) : m.channels_add_desc()}
  testid="channel-sheet"
>
  {#if !type}
    <ul class="grid grid-cols-2 gap-2">
      {#each CHANNEL_TYPES as t (t.type)}
        {@const Icon = icons[t.type]}
        <li>
          <button
            type="button"
            class="flex w-full flex-col items-start gap-2 rounded-xl border p-3 text-left text-sm hover:bg-muted/50"
            data-testid={`channel-type-${t.type}`}
            onclick={() => pick(t.type)}
          >
            <Icon class="size-5 text-primary" />
            {typeLabel(t.type)}
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <form
      id="channel-form"
      class="space-y-4"
      novalidate
      onsubmit={(e) => {
        e.preventDefault();
        void review();
      }}
    >
      {#each fieldsFor(type) as f (f.key)}
        <label class="block">
          <span class="mb-1.5 block text-sm font-medium">{fieldLabel(f.key)}</span>
          <input
            class="h-10 w-full rounded-lg border bg-background px-3 text-sm"
            type={f.kind === 'secret' ? 'password' : f.kind === 'email' ? 'email' : f.kind === 'url' ? 'url' : 'text'}
            autocomplete="off"
            placeholder={f.placeholder}
            bind:value={values[f.key]}
            aria-invalid={!!errors[f.key]}
            data-channel-field={f.key}
          />
          {#if errors[f.key]}<span class="mt-1 block text-xs text-destructive" role="alert">{errorText(errors[f.key]!)}</span>{/if}
          {#if prefs.lens}<span class="mt-1 block font-mono text-[11px] text-muted-foreground" data-lens>alerts.channels[].{f.key}</span>{/if}
        </label>
      {/each}
      {#if type === 'webpush'}
        <p class="text-sm text-muted-foreground">{m.channel_webpush_note()}</p>
      {/if}
    </form>
  {/if}

  {#snippet footer()}
    {#if type}
      <div class="flex gap-2">
        <Button variant="secondary" class="flex-1" onclick={() => (type = null)}>{m.common_back()}</Button>
        <Button class="flex-1" type="submit" form="channel-form" data-testid="channel-review">{m.action_review()}</Button>
      </div>
    {/if}
  {/snippet}
</Sheet>
