import { normalizeNipId } from "./config";
import { nipPlugins } from "./plugins/nips";
import type { PluginContext, RelayPlugin } from "./plugins/types";
import type { NipId, NostrEvent, NostrFilter, RelayConfig, ValidationResult } from "./types";

export type { PluginContext, RelayPlugin } from "./plugins/types";

export class PluginManager {
  readonly enabled: RelayPlugin[];
  readonly disabled: Map<NipId, RelayPlugin>;
  readonly supportedEventKinds: ReadonlySet<number>;

  constructor(plugins: RelayPlugin[], disabledNips: Set<NipId>) {
    const disabled = new Set([...disabledNips].map(normalizeNipId));
    this.enabled = plugins.filter((plugin) => !disabled.has(plugin.nip));
    this.disabled = new Map(plugins.filter((plugin) => disabled.has(plugin.nip)).map((plugin) => [plugin.nip, plugin]));
    this.supportedEventKinds = new Set(this.enabled.flatMap((plugin) => plugin.eventKinds));
  }

  supportedNips(): number[] {
    return this.enabled
      .filter((plugin) => plugin.advertise && /^\d+$/.test(plugin.nip))
      .map((plugin) => Number.parseInt(plugin.nip, 10))
      .sort((a, b) => a - b);
  }

  pluginManifest() {
    return this.enabled.map((plugin) => ({
      nip: plugin.nip,
      name: plugin.name,
      relay: plugin.relay,
      advertised: plugin.advertise,
      eventKinds: plugin.eventKinds,
    }));
  }

  disabledKindReason(kind: number): string | undefined {
    if (this.supportedEventKinds.has(kind)) return undefined;
    for (const plugin of this.disabled.values()) {
      if (plugin.eventKinds.includes(kind)) return `unsupported: NIP-${plugin.nip} plugin is disabled`;
    }
    return undefined;
  }

  async validateEvent(event: NostrEvent, context: PluginContext): Promise<ValidationResult> {
    for (const plugin of this.disabled.values()) {
      const result = await plugin.validateEventWhenDisabled?.(event, context);
      if (result && !result.ok) return result;
    }

    const disabledReason = this.disabledKindReason(event.kind);
    if (disabledReason) return { ok: false, prefix: "unsupported", message: disabledReason.slice("unsupported: ".length) };

    for (const plugin of this.enabled) {
      const result = await plugin.validateEvent?.(event, context);
      if (result && !result.ok) return result;
    }
    return { ok: true };
  }

  async afterEventAccepted(event: NostrEvent, context: PluginContext): Promise<void> {
    for (const plugin of this.enabled) await plugin.afterEventAccepted?.(event, context);
  }

  async authorizeFilters(filters: NostrFilter[], context: PluginContext): Promise<ValidationResult> {
    for (const plugin of this.enabled) {
      const result = await plugin.authorizeFilters?.(filters, context);
      if (result && !result.ok) return result;
    }
    return { ok: true };
  }

  async filterOutgoingEvents(events: NostrEvent[], context: PluginContext): Promise<NostrEvent[]> {
    let filtered = events;
    for (const plugin of this.enabled) filtered = await plugin.filterOutgoingEvents?.(filtered, context) ?? filtered;
    return filtered;
  }

  isEnabled(nip: NipId): boolean {
    const normalized = normalizeNipId(nip);
    return this.enabled.some((plugin) => plugin.nip === normalized);
  }
}

export function createPluginManager(config: RelayConfig): PluginManager {
  return new PluginManager(nipPlugins, config.disabledNips);
}

export function implementedNips(): NipId[] {
  return nipPlugins.map((plugin) => plugin.nip);
}
