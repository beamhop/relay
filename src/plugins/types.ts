import type { EventStore } from "../storage";
import type { ConnectionState, NipId, NostrEvent, NostrFilter, RelayConfig, ValidationResult } from "../types";

export interface PluginContext {
  config: RelayConfig;
  store: EventStore;
  relayUrls: string[];
  connection?: ConnectionState;
}

export interface RelayPlugin {
  nip: NipId;
  name: string;
  relay: boolean;
  advertise: boolean;
  eventKinds: number[];
  validateEvent?(event: NostrEvent, context: PluginContext): Promise<ValidationResult> | ValidationResult;
  validateEventWhenDisabled?(event: NostrEvent, context: PluginContext): Promise<ValidationResult | undefined> | ValidationResult | undefined;
  afterEventAccepted?(event: NostrEvent, context: PluginContext): Promise<void> | void;
  authorizeFilters?(filters: NostrFilter[], context: PluginContext): Promise<ValidationResult> | ValidationResult;
  filterOutgoingEvents?(events: NostrEvent[], context: PluginContext): Promise<NostrEvent[]> | NostrEvent[];
}
