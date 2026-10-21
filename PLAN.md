# Beamhop Relay — Product & Technical Plan

> A Nostr relay + Blossom media server in one bundle, with a mobile-first admin app that hides complexity without hiding power.

Status: draft v1 · 2026-10-21 · Owner: Tolga (solo + Claude)

---

## 1. Vision & principles

**One sentence:** Run a world-class Nostr relay and Blossom server anywhere in 60 seconds, and manage it from your phone with a swipe.

Principles (tie-breakers for every decision):

1. **Convenience over technicality.** Defaults are opinionated and correct. A setting that most admins never need lives behind "Advanced".
2. **Health first, settings last.** The admin opens the app to answer "is everything OK, and what needs me?" — not to browse toggles.
3. **Every change is safe.** Plain-language diff preview, instant apply, undo window. No scary confirm dialogs.
4. **Thumb-first.** Every primary flow is completable one-handed on a phone.
5. **Runs anywhere, same product.** Single binary, Docker, GCP VM, PaaS, Cloudflare edge — identical admin experience.
6. **Spec-complete, honestly.** A public conformance suite proves what we support.
7. **Private by default.** No telemetry, hashed IPs, honored deletions.
8. **Remove decisions, don't organize them.** Goals over knobs, a hard complexity budget, plain language with a technical lens, and every mistake recoverable (§6.6–6.14).
9. **Enterprise is invisible until enabled.** Core defines extension points; enterprise is just their biggest consumer. Non-enterprise admins never see, load, configure, or pay performance for enterprise features (§12.0).

Target admin: **pro / infra operators** — but the UX must be simple enough that a hobbyist succeeds on day one.

---

## 2. Scope

### MVP (v1)
- Relay core, broad NIP set (§4.1), 10k conns / 5k events/s per node
- Blossom server, full BUDs + media optimization (§4.2)
- **Virtual relays** — multiple relays per node by hostname/path, each with its own persona/policy
- Storage: SQLite (default), Postgres; blobs on disk / S3 / R2 / GCS
- Runtimes: **Bun** (binary/Docker/VM/PaaS) and **Cloudflare** (Workers + Durable Objects + D1 + R2)
- Admin PWA: health home, personas wizard, live dashboard, swipe moderation, people/access, media, settings, alerts, AI assistant
- Access: open, allowlist, WoT (follow graph N hops), NIP-42 AUTH gating
- **Tiers abstraction** (admin-assigned limits/quotas) — payment-ready, no payments
- Moderation: swipe queue, auto spam filters, NIP-56 reports, NIP-86 API, CSAM/perceptual-hash scanning
- Insights: live ops, smart alerts, community analytics, Prometheus/OTel
- Alerts via web push, NIP-17 DM, Telegram/Discord/Slack, email
- Policy plugins (TS) + catalog + webhooks
- Data lifecycle: NIP-09, NIP-62, retention/TTL, scheduled backups, privacy-first logs
- Public surfaces: relay landing page, user self-service portal, status page
- Deploy: single binary, Docker/compose, GCP Compute Engine, Fly/Railway/Render, DigitalOcean/Hetzner, Cloudflare
- Docs: one-page quickstart, in-app contextual help, generated reference
- i18n-ready (English only), zero telemetry
- **Enterprise (§12):** Google Workspace / Entra ID / generic OIDC + SCIM, npub binding with self-custody or managed keys, group mapping, offboarding, compliance (SIEM, legal hold, eDiscovery, residency, encryption at rest), DM escrow, approval workflows, network controls, active-passive HA, air-gapped install
- **Team client (§13):** Slack-like PWA with SSO, channels, DMs, files, search

### Post-MVP
- **v2 Fleet:** control plane managing many nodes; node switcher; staged rollouts
- **Paid access:** plug a billing source into tiers (fiat/webhook-driven). No crypto/Lightning/zaps.
- Migration importers (strfry, nostr-rs-relay, khatru), Umbrel/Start9/Coolify templates, dry-run/shadow mode for rules, more languages

### Explicit non-goals
- Lightning, Cashu, zaps, any cryptocurrency
- Project telemetry
- Native mobile apps (PWA only)

---

## 3. Architecture

### 3.1 Shape

```
                ┌────────────────────────────── Beamhop node ──────────────────────────────┐
 Nostr clients ─┤ WS  ─► Relay engine ─┐                                                     │
 Blossom clients┤ HTTP─► Blossom engine├─► Policy pipeline ─► Storage ports ─► SQLite/PG/D1   │
 Admin PWA     ─┤ HTTP─► Admin API ────┘   (built-ins +       (events, blobs,   disk/S3/R2/GCS│
 Public pages  ─┤ HTTP─► Landing/Portal/Status  plugins)       config, metrics)               │
                │        Metrics/Alerts ─► Notifiers (push, DM, chat, email) · /metrics · OTel│
                └───────────────────────────────────────────────────────────────────────────┘
```

**Hexagonal core.** Domain packages are pure TypeScript with zero runtime APIs. Everything touching I/O goes through **ports** with per-runtime **adapters**. This is non-negotiable because Cloudflare is in the MVP.

| Port | Bun adapter | Cloudflare adapter |
|---|---|---|
| `Transport` (WS/HTTP) | `Bun.serve` | Worker fetch + DO WebSocket Hibernation |
| `EventStore` | SQLite (WAL) / Postgres | D1 (+ DO-local SQLite for hot sets) |
| `BlobStore` | fs / S3 / GCS / R2 | R2 |
| `KV/Config` | SQLite table | D1 / KV |
| `PubSub` (fan-out) | in-process | Durable Object per relay shard |
| `Scheduler` | timers | Cron Triggers / DO alarms |
| `MediaProcessor` | sharp/ffmpeg sidecar | Cloudflare Images / deferred queue |
| `PluginHost` | hot-reload, sandboxed worker | compiled into bundle at deploy |
| `LLM` | Ollama / any OpenAI-compatible URL | remote OpenAI-compatible URL |

### 3.2 Multi-tenancy (virtual relays)
- Every row, metric, policy, and blob reference carries `relay_id`.
- Routing by `Host` header (+ optional path prefix). Each virtual relay has its own NIP-11, persona, policy, tiers, landing page.
- Blobs are content-addressed and **deduplicated across relays** on a node; ownership/quotas are per relay.

### 3.3 Fleet-ready from day one (v2 enabler)
- Admin API is scoped `/{node}/{relay}/…`; the PWA only talks to nodes via this API.
- v1 node = its own control plane. v2 adds a control-plane service the nodes register with (outbound connection, so nodes behind NAT work).

### 3.4 Config model — UI and file, synced
- Canonical config = typed schema (Zod/Valibot) → generates UI forms, validation, docs, JSON Schema.
- Stored in DB with **version history**; every change is a revision with author npub, diff, and undo.
- `beamhop.yaml` optional: if present at boot, it wins and becomes a new revision. UI edits are written back to the file (when writable) so GitOps users keep a clean source of truth.

### 3.5 Performance plan (10k conns / 5k ev/s per node)
- Bun WS with per-connection backpressure; binary-safe JSON fast path.
- Subscription index: inverted indexes on kind/author/tag for O(matching) fan-out, not O(subs).
- Signature verification via `@noble/secp256k1` with a batched worker pool; dedupe by id before verify.
- SQLite WAL, prepared statements, write batching (group commit every N ms).
- Load test suite in CI fails builds on regression.

### 3.6 Monorepo (Bun workspaces)
```
packages/
  core/            pure domain: event model, validation, filters, NIP logic
  relay/           relay engine (WS protocol, subscriptions, NIP handlers)
  blossom/         BUD handlers, auth, quotas
  policy/          pipeline, built-in filters, WoT crawler, spam heuristics
  storage-sqlite/  storage-postgres/  storage-d1/
  blob-fs/ blob-s3/ blob-r2/ blob-gcs/
  media/           thumbnails, resize, EXIF strip, transcode, perceptual hash
  admin-api/       REST + SSE/WS live channel, NIP-86, auth, RBAC, audit
  alerts/          rules, anomaly detection, notifiers
  ai/              assistant: tools over metrics/config, OpenAI-compatible client
  plugin-sdk/      plugin types, test harness, sandbox
  pwa/             SvelteKit admin app (static build, embedded)
  public-web/      landing page, self-service portal, status page
  identity/        OIDC, SCIM server, directory sync, npub binding, group mapping
  keyvault/        envelope encryption, KMS/Vault providers, isolated signer, NIP-46 bunker
  compliance/      SIEM export, legal hold, eDiscovery, approval workflows, usage reports
  team-client/     SvelteKit team chat PWA
  runtime-bun/     binary entry, ACME, adapters wiring
  runtime-cf/      Worker + Durable Objects entry, wrangler config
  cli/             `beamhop` CLI (init, backup, restore, user, plugin)
  conformance/     NIP/BUD test suite (runnable against any relay)
deploy/            docker, compose, gcp (terraform), fly, railway, render, do, hetzner, cloudflare
```

---

## 4. Protocol coverage

### 4.1 NIPs (v1)
01, 02, 09, 11, 13 (PoW), 17 + 59 (DMs / gift wraps), 29 (groups), 40 (expiration), 42 (AUTH), 45 (COUNT), 50 (search; SQLite FTS5 / PG tsvector / D1 FTS5), 56 (reports), 62 (right to vanish), 65, 70 (protected events), 77 (negentropy), 86 (relay management API).

### 4.2 Blossom (v1)
BUD-01 (get/head), 02 (upload/list/delete), 03 (server list), 04 (mirror), 05 (media optimization), 06 (upload requirements), plus auth via kind 24242.
- Media pipeline: EXIF strip on upload, thumbnails, responsive resizes, video transcode (Bun only; CF deferred/limited).
- Storage tiers: hot (disk) / cold (object store), orphan GC, per-tier quotas, TTL.
- Every upload is perceptually hashed and checked against block lists before it is served.

---

## 5. Access, tiers, moderation

### 5.1 Access modes (per virtual relay, combinable)
- **Open** — rate limits + spam filters.
- **Allowlist** — npubs, invite links/codes.
- **WoT** — owner's follow graph to depth N with min-follower threshold; refreshed on schedule.
- **AUTH-gated** — NIP-42 required for read and/or write.

### 5.2 Tiers (payment-ready)
Tier = named bundle of limits: events/min, max event size, allowed kinds, Blossom quota, max blob size, retention. Admin assigns tiers manually or via rules (e.g. "WoT depth 1 → Plus"). Post-MVP, a billing source assigns tiers via API/webhook.

### 5.3 Moderation
- **Auto filters (on by default, persona-tuned):** rate limits, PoW for new keys, duplicate/near-duplicate content hashing, link/keyword packs, known-bad pubkey lists, burst detection.
- **Reports:** NIP-56 events land in the queue.
- **Swipe queue:** card per item (event, user, blob). → keep, ← remove, ↑ ban author, ↓ skip. AI pre-labels with a reason. Undo toast after every swipe.
- **CSAM/abuse media:** perceptual hash matching against configured lists; matches are quarantined (never served), admin notified, audit-logged.
- **NIP-86:** standard management API so third-party clients can moderate too.

---

## 6. Admin app (PWA)

SvelteKit, static build embedded in the binary, installable, offline shell, web push. Calm & minimal, dark-first, Linear/Vercel feel.

### 6.1 Navigation — bottom tab bar
**Home · Activity · People · Media · Settings** (+ a floating assistant/command button, ⌘K on desktop). Relay switcher at top when >1 virtual relay.

| Tab | What lives there |
|---|---|
| **Home** | Health score (0–100) + swipeable *attention cards* ("3 reports to review", "Disk 82%", "Spam wave blocked — 4.2k events"). Each card has one primary action. Below: 4 sparkline tiles (connections, events/s, errors, storage). |
| **Activity** | Live event stream (filterable), moderation queue (swipe mode), errors & logs, alert history. |
| **People** | Users with tier, activity, storage; swipe row → ban/mute/tier/inspect. Admins & roles. Invites. WoT settings. |
| **Media** | Blob gallery (grid), quotas, storage tiers, quarantined items, GC status. |
| **Settings** | Persona at top ("You're a *WoT community*. Change?"), then grouped sections each with simple view + "Advanced" sheet. Plugins, alerts, backups, domains/TLS, config history. |

Insights (analytics) are reachable from Home tiles and each tab's header — not a separate tab.

### 6.2 Interaction patterns
- Swipe triage card stacks (moderation, attention cards, approvals)
- Swipe list actions (iOS Mail style) on rows
- Bottom sheets for detail; draggable, dismiss-by-swipe
- Pull-to-refresh, haptics (Vibration API where available)
- **Undo toasts instead of confirmations**; destructive actions get a delayed commit
- Every setting has an ⓘ sheet: plain explanation, example, recommended value

### 6.3 Safe changes
Each change → plain-language diff ("New users must solve PoW 20 → 24. ~3% of current posts would be rejected.") → Apply → 5-min undo. Full revision history with rollback.

### 6.4 Admin auth & roles
- Login: NIP-07 extension, NIP-46 bunker, **passkeys** fallback, **company SSO** (OIDC, §12).
- Roles: **Owner, Admin, Moderator, Viewer**, scoped per virtual relay. Full audit log.
- API tokens: scoped, expiring, for automation.

### 6.5 AI assistant (optional, off by default)
Backend: any OpenAI-compatible URL (Ollama locally, remote on edge). Capabilities:
1. **Explain & diagnose** — tool access to metrics, logs, config (read-only).
2. **Propose changes** — always rendered as the standard diff; admin applies.
3. **Moderation pre-labels** — label + reason on queue cards.
4. **Write policy plugins** — generates TS plugin, runs tests from plugin-sdk harness, installs disabled for admin review.
The assistant never applies changes on its own.

### 6.6 Complexity budget (hard rules)
- **≤ 7 settings per simple screen.** Anything beyond goes to Advanced or becomes derived from a goal.
- **Every top-20 admin task ≤ 3 taps.** The list of tasks is maintained in the repo and tested in E2E.
- **Plain language with a technical lens.** Simple view never shows jargon ("Reports", not "kind 1984"). A **"Show technical details"** lens (per item or app-wide) reveals the underlying terms, NIP numbers, kinds, and raw values next to the plain wording — depth is one tap away, never hidden.
- **Usability tests every milestone:** 5 testers, including non-technical ones, complete key tasks unaided; ≥ 90% success to pass.

### 6.7 Goals instead of knobs
Settings are expressed as **goals**; Beamhop derives the concrete values. Advanced shows exactly which numbers each goal produced and allows overrides (an override is marked and kept visible).

| Goal | Plain control | Drives (examples) |
|---|---|---|
| Openness | Open ↔ Strict | access mode, PoW, rate limits, new-key restrictions |
| Spam tolerance | Relaxed ↔ Aggressive | filter thresholds, duplicate detection, link limits |
| Storage | Keep everything ↔ Keep it lean | retention, per-kind TTL, blob GC, tier quotas |
| Media | Basic ↔ Rich | sizes, transcoding, thumbnails, upload limits |
| Speed vs cost | Cheapest ↔ Fastest | caches, batching, worker pool, resource advice |

Personas are just starting positions on these sliders.

### 6.8 Suggestions, not autopilot (strictly manual)
- Beamhop continuously proposes adjustments (tighten limits during a wave, prune storage, renew/fix config), but **nothing changes without explicit admin approval**.
- **Batching:** similar suggestions collapse into one card ("Block 14 keys from the same spam wave").
- **3am safety:** existing rules (filters, rate limits, access mode) **always keep enforcing**; only *changes* to rules wait for approval. Urgent suggestions push to the on-call admin.

### 6.9 Communication rhythm
- **Inbox-zero Home:** attention cards are an inbox; a healthy relay is clearable in under a minute.
- **Only when needed:** push alerts are reserved for items requiring action.
- **Digest:** daily or weekly — health, growth, pending suggestions, and one optional learning tip.
- **Chat with the relay:** the assistant answers "how are we doing?" from any screen, with context of that screen.

### 6.10 Help when lost
- **"Why?" everywhere:** every number, alert, block, and rejected event has a sheet with cause and options.
- **Guided playbooks:** step-by-step flows for *Spam attack*, *Disk filling up*, *Moving servers*, *Lost admin access*, *Relay is slow*, *Certificate problem*.
- **Sandbox:** try a change against a simulated copy with replayed recent traffic and see what would have been accepted/rejected before applying.

### 6.11 Recovery from mistakes
- **Config time machine:** visual timeline of revisions; restore any point in one tap.
- **Recycle bin:** deleted events/blobs and bans recoverable for 30 days (respects NIP-09/62 and legal hold semantics: user-requested deletions are not recoverable).
- **Owner recovery:** recovery codes at setup + optional second owner, so a lost nostr key never locks out the relay.
- **Safe mode:** `beamhop --safe` boots with the last known-good config.

### 6.12 Team of admins
- **Activity feed:** plain who-did-what ("Ayşe banned 3 keys · 2h ago"), linked to the audit log.
- **Internal notes** on users, events, and blobs, visible to the admin team only.
- **On-call schedule:** alerts and urgent suggestions route to whoever is on duty.

### 6.13 Power users
- **Command palette** (⌘K / search button on phone): jump anywhere, run any action.
- **Keyboard shortcuts:** j/k navigate, e keep, x remove, # ban, u undo, ? help.
- **Bulk actions:** multi-select users/events/blobs → act (with the standard diff + undo).
- **CLI & API parity:** every UI action exists in the `beamhop` CLI and admin API (enforced by generating both from one action registry).

### 6.14 Devices
**Full parity** between phone and desktop. Same IA and features; desktop adds split panes, denser tables, and keyboard shortcuts.

---

## 7. Onboarding — 60-second wizard

1. `curl -fsSL get.beamhop.dev | sh && beamhop` (or `docker run`, or one-click button)
2. Terminal prints a one-time URL + claim code.
3. Open URL → **log in with Nostr** (or passkey) → you are Owner.
4. Pick persona: **Public social · Private team · WoT community · Media host** (plus **Company / Organization**, which adds the enterprise steps — §12.0).
5. Domain: enter hostname → TLS auto-detected (ACME if on :443 with public IP; else proxy mode with a check that headers arrive correctly).
6. Done screen: relay URL, Blossom URL, QR code, "Share landing page", "Enable phone alerts".

Personas preconfigure ~50 settings (access mode, filters, kinds, quotas, retention, media options) by setting goal positions (§6.7).

**First week:**
- **Setup checklist** on Home with a progress ring (backups configured, alerts on, recovery codes saved, landing page customized, moderator invited); disappears when complete.
- **Launch kit:** shareable QR, draft announcement note, NIP-11 polish, "Test my relay" button (connect, publish, fetch, upload from outside).
- **Learning nudges:** one tip per digest, dismissible forever.

**Success metrics** (measured in usability studies and shown locally to the admin — never sent anywhere):
- Time to first live relay < 60 s
- Healthy relay needs < 10 admin minutes/week
- ≥ 90% unaided task success in usability tests

---

## 8. Insights, alerts, observability

- **Live ops** (SSE): connections, REQ/s, EVENT/s, accept/reject ratio by reason, p50/p95 latency, DB size, blob storage, error rate.
- **Health score:** weighted from subsystem checks (availability, error rate, latency, disk headroom, backup freshness, queue backlog, cert expiry).
- **Smart alerts:** baseline-aware anomaly detection (EWMA/seasonal) for spam waves, error spikes, connection drops, disk fill ETA, cert expiry, backup failures. Sensible defaults; one-tap mute/snooze.
- **Notifiers:** web push, NIP-17 DM to admin npubs, Telegram/Discord/Slack, email (SMTP).
- **Community analytics:** active users, top kinds, clients (from tags/UA), retention cohorts, storage by user, coarse geo (from hashed/truncated IPs only).
- **Export:** `/metrics` Prometheus, OTel traces/metrics; Grafana dashboard JSON shipped.
- **Logs:** structured, IPs hashed by default, in-app viewer with filters.

---

## 9. Extensibility

- **Policy plugins (TS):** hooks `onConnect`, `onAuth`, `onEvent`, `onReq`, `onUpload`, `onBlobServe`; return accept/reject/modify with reason. Hot-reloaded on Bun (sandboxed worker, time/memory limits); **bundled at deploy** on Cloudflare.
- **Catalog:** curated, signed plugin index; one-tap install (WoT filter variants, spam packs, keyword packs, bridges).
- **Webhooks:** event-matched and admin-event webhooks, signed payloads, retries.

---

## 10. Data lifecycle & privacy

- NIP-09 deletions and **NIP-62 right to vanish** (events + owned blobs).
- Retention per kind / per tier; NIP-40 expiration; storage caps with auto-pruning by policy.
- **Backups:** scheduled snapshots (SQLite online backup / pg_dump / D1 export + blob manifest) to S3/GCS/R2; one-tap restore; backup freshness in health score.
- **Privacy:** IPs hashed (salted, rotating) or truncated by default; zero project telemetry.

---

## 11. Public surfaces (per virtual relay)

- **Landing page:** NIP-11 data, rules, join/invite flow, how-to-connect, branding.
- **Self-service portal:** users log in with Nostr → see tier, quota, their blobs, export data, delete/vanish.
- **Status page:** uptime, current incidents (auto-opened from alerts, editable by admin).
- Each surface can be disabled per relay (**private-only** mode for internal deployments).

---

## 12. Enterprise (MVP, AGPL — all features open)

Goal: a company can run Beamhop as its internal Nostr backbone, with employees signing in through the corporate identity provider, without Beamhop losing its Nostr-native model.

### 12.0 Isolation — enterprise must not complicate anyone else
1. **Single entry point.** Enabled only via the **"Company / Organization"** persona in the wizard, or Settings → *Connect your company directory*. Until then: no tabs, menu items, settings, attention cards, or wizard steps. The four standard personas and the 60-second wizard are unchanged.
2. **Code isolation.** `identity`, `keyvault`, `compliance`, `team-client` register through the same extension points as plugins (auth providers, NIP-42 access check, config sections, PWA routes, audit sinks). **Core never imports them**; deleting them still yields a working relay. Shipped in the same binary (one AGPL artifact) but not initialized until enabled; PWA screens are code-split and never downloaded by non-enterprise admins.
3. **No data/config footprint.** Enterprise tables are created by module-scoped migrations on enable. Config lives in a single optional `enterprise:` block, absent by default. Shared concepts (tiers, roles, access) stay generic; enterprise only adds *sources* for them (e.g. IdP group → tier).
4. **Zero hot-path cost.** When disabled, no binding lookups, SIEM sinks, or escrow logic are registered in the event path. Performance targets are measured on the vanilla profile.
5. **Progressive inside enterprise.** Connecting an IdP turns on only SSO, npub linking, and group mapping. Compliance, escrow, mTLS, HA, air-gap appear as suggestions and are enabled one by one.
6. **Enforced in CI.** A *vanilla* profile asserts: no enterprise module loaded, no enterprise tables, no enterprise strings in the PWA, admin bundle within size budget, wizard flow snapshot unchanged.
7. **Separate docs.** The quickstart never mentions enterprise; enterprise docs are linked only from the Company persona.
8. **Core-change rule.** If an enterprise feature needs something from core, it must be added as a generic extension point that benefits all deployments.

### 12.1 Identity providers
- **Google Workspace** — OIDC login + Directory API polling sync (users, groups, suspensions).
- **Microsoft Entra ID** — OIDC login + **SCIM 2.0** provisioning (push).
- **Generic OIDC + SCIM** — Okta, Keycloak, Authentik, Auth0, JumpCloud.
- SAML is out of scope (revisit on demand).
- Wizard: "Private team" persona asks *Google / Microsoft / Other OIDC?* and walks through app registration with copy-paste values and a live connection test.

### 12.2 Identity ↔ npub binding
SSO identities never replace Nostr signatures; they are **bound to npubs**. Two key models, chosen per relay **and** per IdP group:

| Model | Flow | Notes |
|---|---|---|
| **Self-custody (linked npub)** | Employee signs in with SSO in the portal → signs a challenge with their own signer (NIP-07/46) → npub bound to their directory identity. | Employee owns key; company controls access, not identity. |
| **Managed keys** | On first SSO login Beamhop generates a keypair and exposes it via a built-in **NIP-46 bunker**; the SSO session unlocks signing. Works in the bundled team client and any NIP-46-capable client. | Company is key custodian. Keys are **not exportable**. |

Binding table: `(idp, subject, email) ↔ npub ↔ key_model ↔ groups`. NIP-42 AUTH checks the npub against live binding state, so access follows the directory in real time.

### 12.3 Key custody (managed keys)
- **Envelope encryption:** each private key encrypted with a per-tenant data key; data keys wrapped by a key-encryption-key (KEK).
- **KEK providers:** local master key (env/file), **GCP KMS, Azure Key Vault, AWS KMS**, Cloudflare secrets, **HashiCorp Vault Transit**.
- Signing happens in an isolated signer module; plaintext keys never leave it; every signature is audit-logged (who, what kind, which client).
- Rate limits and anomaly alerts on signing volume.

### 12.4 Group mapping
IdP groups map to all four dimensions, edited as one simple table in People → Groups:
- **Relay access** — which virtual relays the group can read/write
- **Tier** — limits, quotas, retention
- **Admin role** — Owner / Admin / Moderator / Viewer
- **Key model** — self-custody or managed

Admin SSO login for the PWA uses the same mapping (OIDC alongside Nostr login and passkeys).

### 12.5 Lifecycle & offboarding
On suspension/removal (SCIM push or directory poll):
1. **Revoke immediately** — npub unbound, removed from allowlists, live WS sessions and bunker sessions dropped, API tokens revoked.
2. **Keep data** per retention policy / legal hold.
3. **Transfer ownership** — groups they own, channels, and blobs reassigned to their manager (from IdP) or a chosen successor.
4. **Destroy managed key** — crypto-shred after a configurable grace period, **blocked while under legal hold**.

### 12.6 Company identity on Nostr
- **Auto NIP-05:** `alice@company.com` served from `/.well-known/nostr.json`, derived from directory.
- **Profile sync:** name, title, department, avatar → kind 0 (managed keys: signed automatically; self-custody: proposed to the user).
- **Auto groups:** IdP groups/teams become NIP-29 groups with synced membership.
- **Company directory:** browsable employee list; contact-list seeding (follow your team / whole org).

### 12.7 Compliance
- **Audit export / SIEM:** admin, auth, binding, signing and escrow events streamed to syslog, Splunk HEC, Microsoft Sentinel, Google Chronicle, or webhook; tamper-evident hash chain.
- **Legal hold & eDiscovery:** freeze deletion (NIP-09/62, retention, crypto-shred) by user, group or date range; export events + blobs as a signed, verifiable archive.
- **Retention by group:** e.g. Finance 7 years, default 90 days; legal hold overrides.
- **Data residency:** region pinning per virtual relay for DB and blob stores; enforced at adapter config.
- **Encryption at rest:** DB and blobs encrypted with KMS-backed keys (same KEK providers as §12.3).
- **Usage reports:** monthly per-group CSV/PDF (users, events, storage, bandwidth) for cost allocation.

### 12.8 DM escrow (managed keys only, optional)
- When enabled, the company can decrypt NIP-17 DMs of **managed-key** users for legal/compliance requests. Self-custody DMs remain end-to-end and unreadable.
- **Disclosed to users** in the client and portal ("Your messages on this workspace may be accessed for compliance").
- Every decryption requires an **approval workflow** (§12.9), a stated reason, and is written to the audit log/SIEM.

### 12.9 Approval workflows (two-person rule)
Sensitive actions require a second admin's approval from the PWA (push notification → swipe approve/deny): escrow decrypt, managed-key destruction, legal hold release, bulk delete, KEK rotation, IdP disconnect. Configurable list; requests expire.

### 12.10 Network controls
- IP/CIDR allowlists per relay and for the admin app.
- **mTLS / device certificates** — only managed devices connect (cert issued by company CA).
- Supported mode **behind IAP / zero-trust proxies** (Google IAP, Cloudflare Access, Entra App Proxy) with identity headers trusted from the proxy.
- Private-only mode: no landing/status pages, NIP-11 minimal.
- Team client federation: **internal relays only by default**; admin may allow outbound relays per group.

### 12.11 High availability
- **MVP: active-passive** — SQLite replicated via Litestream/LiteFS to a standby; health-checked failover; documented RPO ≤ 1 min / RTO ≤ 5 min.
- **v2: active-active** on Postgres + pub/sub, delivered with Fleet.
- Cloudflare deployments inherit platform HA.

### 12.12 Air-gapped install
- Offline bundle: binary, PWA, team client, plugin catalog snapshot, media tools, docs.
- Signed offline update packages; no outbound calls (ACME off, catalog local, AI → on-prem Ollama).

---

## 13. Team client (MVP)

A Slack-like PWA for employees, built on the same SvelteKit stack and served by Beamhop at `/app`. Any Nostr client still works; the team client is the zero-friction default.

- **Sign-in:** company SSO → bound npub (managed key via built-in bunker, or self-custody via NIP-07/46).
- **Channels & threads:** NIP-29 groups (auto-created from IdP groups or ad-hoc), threaded replies, reactions.
- **DMs & group DMs:** NIP-17 gift wraps, with escrow notice when applicable.
- **Files:** drag-drop to Blossom, previews (images/video/PDF), per-channel file list.
- **Search & mentions:** NIP-50 search, @mentions, unread state, web push notifications.
- **Directory:** company people list with profiles from the IdP.
- Mobile-first with the same gesture vocabulary as the admin app (swipe to reply/archive, bottom sheets).
- Federation off by default (§12.10).

---

## 14. Deployment

| Target | Artifact |
|---|---|
| Single binary | `bun build --compile` for linux-x64/arm64, macOS, Windows; PWA embedded |
| Docker | multi-arch image on GHCR; compose with optional Postgres/MinIO |
| GCP | Compute Engine VM (COS + persistent disk), Terraform module |
| Fly / Railway / Render | templates + deploy buttons |
| DigitalOcean / Hetzner | cloud-init scripts, DO marketplace image |
| Cloudflare | `npm create beamhop@latest --cf` → wrangler deploy (Workers + DO + D1 + R2) |

| Air-gapped | Offline bundle + signed update packages (§12.12) |
| HA pair | Primary + standby with Litestream/LiteFS (§12.11) |

Upgrades: `beamhop update` / image tag; DB migrations automatic with pre-migration backup.

**Deployer experience:**
- **One-tap updates from the app:** plain-language release notes → auto-backup → update → health check → **automatic rollback** if unhealthy. (Cloudflare: redeploy via stored deploy token.)
- **`beamhop doctor`** (CLI + in-app): checks DNS, TLS, ports, proxy headers, WebSocket upgrade, disk, permissions, clock skew, storage reachability; offers one-step fixes.
- **Move / clone relay:** wizard exports everything (config, events, blobs, keys), imports on the new host, verifies, then guides the DNS switch.
- **Resource advisor:** forecasts disk/CPU/bandwidth ("disk full in ~23 days") with concrete actions.

---

## 15. Quality

- **Conformance suite** (`packages/conformance`) for every NIP and BUD, runnable against any relay; badge published.
- **Load/bench in CI** with regression gates on the 10k/5k target.
- **Fuzzing** of event parsing/validation and filter handling.
- **E2E** Playwright with touch emulation for swipe flows and the wizard.
- **Vanilla vs enterprise profiles** in CI; vanilla guards isolation (§12.0) and owns the perf gates.
- Both runtimes run the same test matrix (Bun + Miniflare/wrangler dev).

---

## 16. Documentation

- One-page quickstart (install → wizard → done).
- In-app ⓘ help per setting (generated from config schema descriptions).
- Auto-generated reference: config, admin API (OpenAPI), plugin SDK.

---

## 17. Licensing

**AGPL-3.0 + commercial license** (dual). CLA or DCO for contributions so dual licensing stays possible.

---

## 18. Roadmap (solo + Claude)

Each milestone ends with something runnable. Bun first within each milestone, CF adapter closes it. Every milestone with UI must pass the complexity budget and usability test gate (§6.6).

| # | Milestone | Outcome |
|---|---|---|
| M0 | Foundations | Monorepo, ports/adapters skeleton, config schema system, CI, conformance harness |
| M1 | Relay core | NIP-01/11/09/40/42/45/70 on SQLite; Bun + CF; conformance green; first load test |
| M2 | Blossom core | BUD-01..04/06 on fs/S3/R2; quotas; dedupe |
| M3 | Admin API + auth | NIP-07/46 login, passkeys, RBAC, audit, config revisions + undo, NIP-86 |
| M4 | PWA shell + wizard | Tab bar, Home health score, personas, onboarding, TLS auto-detect, virtual relays |
| X1 | Admin experience core | Goals engine, technical lens, action registry (UI/CLI/API parity), command palette, shortcuts, config time machine, safe mode, owner recovery |
| M5 | Policy & moderation | Access modes, WoT crawler, tiers, auto filters, swipe queue, NIP-56 |
| M6 | Insights & alerts | Live dashboard, anomaly alerts, all notifiers, Prometheus/OTel, analytics |
| M7 | Media & safety | BUD-05 pipeline, perceptual-hash scanning, quarantine, retention, GC |
| M8 | Remaining NIPs | 13, 17/59, 29, 50, 62, 65, 77 |
| M9 | Extensibility | Plugin SDK, hot reload, CF bundling, catalog, webhooks |
| M10 | Data & public | Backups/restore, landing page, self-service portal, status page |
| M11 | AI assistant | Diagnose, propose diffs, moderation labels, plugin generation |
| E1 | Identity core | OIDC (Google, Entra, generic), admin SSO, npub linking, binding table, group mapping |
| E2 | Provisioning | SCIM 2.0 server, Google Directory sync, offboarding flow, ownership transfer |
| E3 | Managed keys | Envelope encryption, KMS/Vault providers, NIP-46 bunker, signing audit, crypto-shred |
| E4 | Compliance | SIEM export, legal hold, eDiscovery export, retention by group, residency, encryption at rest, usage reports |
| E5 | Governance & network | Approval workflows, DM escrow, IP allowlists, mTLS, IAP mode, private-only |
| E6 | Directory | Auto NIP-05, profile sync, IdP → NIP-29 groups, company directory |
| T1 | Team client shell | SSO sign-in, channels, threads, DMs |
| T2 | Team client complete | Files, search, mentions, push, directory, gestures |
| H1 | HA & air-gap | Litestream/LiteFS active-passive failover, offline bundle + signed updates |
| X2 | Admin experience complete | Suggestions + batching, digest, playbooks, sandbox, recycle bin, team feed/notes/on-call, bulk actions, setup checklist, launch kit, one-tap updates + rollback, doctor, move/clone, resource advisor |
| M12 | Ship | Deploy templates for all targets, quickstart, perf hardening, 1.0 |
| v2 | Fleet | Control plane, node registration, node switcher, staged rollouts |
| v2+ | Paid access | Billing source → tiers |

---

## 19. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Solo scope is very large | Strict milestone gates; every milestone shippable; cut M11/M8 items before slipping 1.0 |
| Bun + CF divergence | Pure core, port contracts tested on both runtimes in CI from M0 |
| CF limits (CPU time, no eval, media processing) | Bundled plugins; DO sharding; media transforms via CF Images or deferred |
| 10k/5k target in TypeScript | Early benchmarks (M1), indexed fan-out, batched verify, worker pool; Postgres option |
| CSAM liability | Hash scanning on by default for public personas; quarantine-first; clear operator docs |
| Persona defaults wrong | Personas are just config revisions — visible, diffable, editable |
| Enterprise + team client roughly doubles MVP scope | E/T tracks run after M5; if 1.0 slips, ship relay 1.0 first and enterprise as 1.1 rather than cutting quality |
| Key custodian liability (managed keys) | Isolated signer, KMS-wrapped keys, signing audit, two-person rule, external security audit before 1.0 |
| DM escrow trust & legal exposure | Managed keys only, off by default, mandatory user disclosure, approval + audit on every decrypt |
| Google Workspace lacks full SCIM | Directory API polling with short interval + login-time checks |

---

## 20. Open questions
- Exact persona default values (finalize during M4/M5).
- Hash list sources for media scanning and their licensing/access requirements.
- Domain for `get.beamhop.dev` / project site.
- Plugin catalog signing and governance.
- DM escrow cryptographic design (managed keys already allow decryption; confirm no additional escrow key is needed).
- Which NIP-46 clients to certify for managed-key login.
