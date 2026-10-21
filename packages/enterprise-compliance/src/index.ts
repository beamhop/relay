// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/enterprise-compliance — two opt-in modules (isolation rule §12.0: each is
 * registered only when its id is a key of `config.modules`):
 *
 * - `enterprise-compliance`: approvals (two-person rule), SIEM export, legal hold &
 *   eDiscovery, retention by group, data residency, encryption at rest, usage reports.
 * - `enterprise-network`: IP/CIDR allowlists, mTLS device certificates, zero-trust
 *   proxies (Google IAP, Cloudflare Access, Entra App Proxy), private-only mode.
 */
export { complianceModule, createComplianceModule, complianceInternals } from './module.ts';
export {
  SIEM_SERVICE,
  HOLDS_SERVICE,
  EDISCOVERY_SERVICE,
  type ComplianceSiemService,
  type ComplianceInternals,
} from './module.ts';
export { networkModule, createNetworkControls, type NetworkControls } from './network/module.ts';
export { NetworkConfigSchema, NETWORK_MODULE_ID, type NetworkConfig } from './network/config.ts';
export {
  ComplianceConfigSchema,
  MODULE_ID,
  DEFAULT_GATED_ACTIONS,
  COL,
  type ComplianceConfig,
  type SinkConfig,
} from './config.ts';
export {
  APPROVALS_SERVICE,
  APPROVAL_FIELD,
  ApprovalError,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalsService,
  type ApprovalCheckRequest,
  type ApprovalCheckResult,
} from './approvals.ts';
export type { HoldScope, HoldSubject, HoldProvider, LegalHold } from './holds.ts';
export {
  verifyArchive,
  ARCHIVE_FORMAT,
  type ExportRecord,
  type ArchiveManifest,
} from './ediscovery.ts';
export { EncryptedBlobStore, encryptInPlace } from './encrypted-blobs.ts';
export { RETENTION_SERVICE, type RetentionProvider } from './retention.ts';
export { checkResidency, regionMatches, type ResidencyIssue } from './residency.ts';
export { renderPdf } from './pdf.ts';
export { parseIp, parseCidr, cidrContains, IpAllowlist } from './network/cidr.ts';
export { MtlsVerifier, decodeCertHeader } from './network/mtls.ts';
export { ZeroTrustVerifier } from './network/zerotrust.ts';
export { verifyOutboxChain } from './siem/exporter.ts';
export { toSyslog, octetFrame, type SiemRecord } from './siem/format.ts';
export type { SyslogTransport, SyslogTransportFactory } from './siem/sinks.ts';
