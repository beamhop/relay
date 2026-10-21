// SPDX-License-Identifier: AGPL-3.0-or-later
/** Response shapes of the Beamhop admin API (`/api/v1/nodes/:node/...`). */

export type Role = 'owner' | 'admin' | 'moderator' | 'viewer';

export interface ApiIssue {
  path: string;
  message: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  technical?: string;
  issues?: ApiIssue[];
}

export interface DiffLine {
  text: string;
  technical?: string;
  kind: 'add' | 'remove' | 'change' | 'info' | 'warning';
}

export interface AuthStatus {
  node: string;
  claimed: boolean;
  providers: Array<{ id: string; label: string }>;
  passkeys: boolean;
}

export interface PrincipalInfo {
  id: string;
  pubkey?: string;
  displayName?: string;
  roles: Record<string, Role>;
  via: string;
  scopes?: string[];
  /** '*' = node-level permissions, plus one entry per relay id. */
  permissions: Record<string, string[]>;
}

export interface SessionResponse {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
  principal: PrincipalInfo;
  recoveryCodes?: string[];
}

export interface SignInCodes {
  claimCode?: string;
  inviteCode?: string;
  recoveryCode?: string;
  displayName?: string;
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  title?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  [key: string]: unknown;
}

export interface CatalogAction {
  id: string;
  title: string;
  description: string;
  technical?: string;
  scope: 'node' | 'relay';
  permission: string;
  readOnly: boolean;
  sensitive: boolean;
  bulk: boolean;
  undoable: boolean;
  hasPreview: boolean;
  keywords: string[];
  shortcut?: string;
  cli: string;
  inputSchema: JsonSchema;
  allowed: boolean;
}

export interface UndoInfo {
  token: string;
  /** Unix seconds. */
  expiresAt: number;
}

export interface RunResult<O = unknown> {
  output: O;
  summary: string;
  undo?: UndoInfo;
}

export interface BulkResult {
  results: Array<{
    ok: boolean;
    output?: unknown;
    summary?: string;
    error?: { code: string; message: string };
  }>;
  summary: string;
  undo?: UndoInfo;
}

export type HealthStatus = 'ok' | 'warn' | 'critical';

export interface Health {
  score: number;
  status: HealthStatus;
  message: string;
  subsystems: Array<{ subsystem: string; score: number; status: HealthStatus; message: string }>;
  checks: Array<{
    id: string;
    subsystem: string;
    weight: number;
    score: number;
    status: HealthStatus;
    message: string;
    technical?: string;
  }>;
}

export interface CardAction {
  label: string;
  actionId: string;
  input: unknown;
}

export interface AttentionCard {
  id: string;
  relayId: string | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  technical?: string;
  batchKey?: string;
  createdAt: number;
  primary?: CardAction;
  secondary?: CardAction;
  playbook?: string;
  count: number;
  items?: AttentionCard[];
  primaryAllowed?: boolean;
  /** False for informational cards: nothing to approve. */
  approvable?: boolean;
}

export interface ConfigProposal {
  id: string;
  baseRevision: number;
  scope: string | null;
  expiresAt: number;
  summary: string;
  changed: boolean;
  diff: DiffLine[];
  patch: Array<{ op: string; path: string; value?: unknown }>;
}

export interface RevisionInfo {
  revision: number;
  at: number;
  author: string;
  authorName: string;
  summary: string;
  source: 'initial' | 'ui' | 'file' | 'undo' | 'restore' | 'import';
  changes: number;
}

export interface CommitResult {
  revision: RevisionInfo;
  undo?: UndoInfo;
}

export interface ActivityItem {
  seq: number;
  at: number;
  relayId: string | null;
  actionId: string;
  actor: string;
  ok: boolean;
  text: string;
}

export interface UiRoute {
  path: string;
  title: string;
  placement:
    | 'settings-section'
    | 'people-section'
    | 'activity-section'
    | 'media-section'
    | 'home-card';
  chunk: string;
}

export interface RelaySummary {
  id: string;
  name: string;
  hosts: string[];
  persona: Persona;
}

export interface NodeInfo {
  id: string;
  runtime: string;
  relays: RelaySummary[];
}

export type Persona =
  | 'public-social'
  | 'private-team'
  | 'wot-community'
  | 'media-host'
  | 'organization';

export interface Goals {
  openness: number;
  spamTolerance: number;
  storage: number;
  media: number;
  speedVsCost: number;
}

/** The subset of a relay's config the app reads directly. */
export interface RelayConfig {
  id: string;
  hosts: string[];
  persona: Persona;
  goals: Goals;
  info: { name: string; description: string; contact?: string; rules?: string; icon?: string };
  access: {
    mode: 'open' | 'allowlist' | 'wot';
    authRequired: { read: boolean; write: boolean };
    wot: { depth: number; minFollowers: number; seeds: string[] };
  };
  tiers: Array<{ id: string; name: string }>;
  defaultTier: string;
  blossom: { enabled: boolean; defaultQuotaBytes?: number; maxBlobBytes?: number };
  public: { landing: boolean; portal: boolean; status: boolean };
  [key: string]: unknown;
}

export interface NodeConfig {
  node: { id: string; tls: { mode: string; email?: string }; trustProxy: boolean };
  relays: RelayConfig[];
  alerts: { channels: Array<{ type: string; id: string }>; digest: string };
  backups: { enabled: boolean; schedule: string; keep: number };
  [key: string]: unknown;
}

export interface SelfCheck {
  ok: boolean;
  nodeId: string;
  tls: 'acme' | 'proxy' | 'off' | string;
  trustProxy: boolean;
  seen: { host: string; proto: string; forwardedFor: boolean };
  relay: { id: string; publicUrl: string } | null;
  problems: Array<{ message: string; technical: string }>;
}

export interface QueueItem {
  id: string;
  relayId: string;
  type: 'event' | 'report' | 'blob';
  status: 'pending' | 'kept' | 'removed';
  createdAt: number;
  reason: string;
  technical?: string;
  source?: string;
  eventId?: string;
  pubkey?: string;
  sha256?: string;
  event?: { id: string; pubkey: string; kind: number; content: string; created_at: number };
  reports?: Array<{
    reportId: string;
    reporter: string;
    type: string;
    comment?: string;
    at: number;
  }>;
}

export interface RecycleEntry {
  id: string;
  type: 'event' | 'blob';
  event?: { id: string; pubkey: string; kind: number; content: string; created_at: number };
  removedAt: number;
  purgeAt: number;
  by: string;
  reason?: string;
}

export interface BlobItem {
  sha256: string;
  pubkey: string;
  size: number;
  type?: string;
  uploadedAt?: number;
  quarantined?: boolean;
  [key: string]: unknown;
}

export interface LimitExplanation {
  field: string;
  value: unknown;
  text: string;
  technical: string;
  source: string;
  goal?: keyof Goals;
}

/** `plugins.catalog` item (subset). */
export interface PluginCatalogItem {
  id: string;
  name?: string;
  version: string;
  description?: string;
  permissions: string[];
  permissionText?: string[];
  builtin?: boolean;
  installed: boolean;
  enabled: boolean;
  compatible?: boolean;
  minBeamhop?: string;
  /** JSON Schema of the plugin settings, when the server publishes it. */
  configSchema?: JsonSchema;
}

/** `plugins.status` row (subset). */
export interface PluginStatusRow {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  status: 'loading' | 'running' | 'error' | 'disabled' | 'tripped';
  mode?: 'in-process' | 'sandbox';
  permissions: string[];
  error?: string;
  tripped?: { reason: string; at: number };
  config?: Record<string, unknown>;
  configSchema?: JsonSchema;
  stats: {
    calls: number;
    rejections: number;
    errors: number;
    timeouts: number;
    p95Ms: number;
    avgMs: number;
    lastError?: string;
  };
}

/** `media.usage-summary` output. */
export interface UsageSummary {
  totalUsedBytes: number;
  people: number;
  nearQuota: number;
  overQuota: number;
  largest: Array<{
    pubkey: string;
    usedBytes: number;
    quotaBytes?: number | null;
    files?: number;
    overQuota?: boolean;
  }>;
}

/** `experience.test-relay` step. */
export interface TestStep {
  id: string;
  title: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  technical?: string;
  ms?: number;
}

/** `experience.test-relay` output. */
export interface TestRelayReport {
  ok: boolean;
  summary: string;
  needsDomain?: boolean;
  steps?: TestStep[];
}

export interface LiveMessage {
  event: string;
  data: unknown;
  id?: string;
}
