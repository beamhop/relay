// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `enterprise-compliance` module. Loaded only when `config.modules['enterprise-compliance']`
 * exists (runtime opt-in, §12.0); contributes nothing otherwise.
 */
import { type AttentionCard, type BeamhopModule, type Kernel, defineModule } from '@beamhop/core';
import { complianceActions } from './actions.ts';
import {
  APPROVALS_SERVICE,
  type ApprovalGate,
  Approvals,
  approvalActions,
  approvalCards,
  installApprovalGate,
} from './approvals.ts';
import { ComplianceConfigSchema, MODULE_ID } from './config.ts';
import { EDiscovery } from './ediscovery.ts';
import { encryptInPlace } from './encrypted-blobs.ts';
import { LegalHolds, type LifecycleHoldsLike } from './holds.ts';
import { UsageReports } from './reports.ts';
import { type ResidencyIssue, checkResidency, residencyHealth } from './residency.ts';
import {
  LIFECYCLE_RETENTION_PROVIDERS,
  RETENTION_SERVICE,
  type RetentionProvidersLike,
  groupRetention,
} from './retention.ts';
import { type Rt, type SiemInput, createRt } from './runtime.ts';
import { type ExporterOptions, SiemExporter } from './siem/exporter.ts';
import { errMsg } from './util.ts';

export const SIEM_SERVICE = 'compliance.siem';
export const HOLDS_SERVICE = 'compliance.holds';
export const EDISCOVERY_SERVICE = 'compliance.ediscovery';

/** `kernel.use<ComplianceSiemService>('compliance.siem')` — other modules push signing/escrow records. */
export interface ComplianceSiemService {
  record(r: SiemInput): void;
}

export interface ComplianceInternals {
  rt: Rt;
  approvals: Approvals;
  siem: SiemExporter;
  holds: LegalHolds;
  ediscovery: EDiscovery;
  reports: UsageReports;
  gate?: ApprovalGate;
  residency: ResidencyIssue[];
  cleanups: Array<() => void>;
}

const internals = new WeakMap<Kernel, ComplianceInternals>();

/** Test / tooling access to a kernel's compliance internals. */
export function complianceInternals(kernel: Kernel): ComplianceInternals | undefined {
  return internals.get(kernel);
}

const JOBS = {
  siem: 'enterprise-compliance.siem',
  reports: 'enterprise-compliance.reports',
  gc: 'enterprise-compliance.gc',
} as const;

export function createComplianceModule(opts: ExporterOptions = {}): BeamhopModule {
  return defineModule({
    id: MODULE_ID,
    configSchema: ComplianceConfigSchema,
    register(kernel) {
      const rt = createRt(kernel);
      const approvals = new Approvals(rt);
      const siem = new SiemExporter(rt, opts);
      rt.setRecorder((r) => {
        void siem.record(r);
      });
      const holds = new LegalHolds(rt);
      const ediscovery = new EDiscovery(rt, holds);
      const reports = new UsageReports(rt, holds);
      const st: ComplianceInternals = {
        rt,
        approvals,
        siem,
        holds,
        ediscovery,
        reports,
        residency: [],
        cleanups: [],
      };
      internals.set(kernel, st);

      kernel.provide(APPROVALS_SERVICE, approvals);
      kernel.provide<ComplianceSiemService>(SIEM_SERVICE, { record: (r) => rt.record(r) });
      kernel.provide(HOLDS_SERVICE, holds);
      kernel.provide(EDISCOVERY_SERVICE, ediscovery);
      kernel.provide(RETENTION_SERVICE, groupRetention(rt));

      for (const a of approvalActions(approvals, rt)) kernel.actions.register(a);
      for (const a of complianceActions({
        rt,
        holds,
        ediscovery,
        siem,
        reports,
        residencyIssues: () => st.residency,
      }))
        kernel.actions.register(a);

      kernel.cards.push(approvalCards(approvals), {
        id: 'enterprise-compliance.residency',
        async cards(relayId): Promise<AttentionCard[]> {
          return st.residency
            .filter((i) => i.severity === 'critical' && (!relayId || i.relayId === relayId))
            .map((i) => ({
              id: `residency:${i.relayId}`,
              relayId: i.relayId,
              severity: 'critical',
              title: 'Data is stored in the wrong region',
              body: i.message,
              technical: i.technical,
              createdAt: rt.now(),
              batchKey: 'residency',
            }));
        },
      });
      kernel.health.push(residencyHealth(() => st.residency));
      kernel.ui.push(
        {
          path: '/settings/compliance',
          title: 'Compliance',
          placement: 'settings-section',
          chunk: 'enterprise-compliance',
        },
        {
          path: '/approvals',
          title: 'Approvals',
          placement: 'activity-section',
          chunk: 'enterprise-compliance',
        },
      );

      // Encryption at rest + legal-hold store guard wrap the store instances now,
      // before any module starts writing.
      const s = rt.settings();
      if (s.encryption.blobs) {
        if (kernel.ports.keyWrapper) {
          st.cleanups.push(encryptInPlace(kernel.ports.blobs, kernel.ports.keyWrapper));
        } else {
          rt.log(
            'error',
            'media encryption is on but no key wrapper (KMS/Vault/master key) is set',
            {},
          );
          kernel.health.push({
            id: 'enterprise-compliance.encryption',
            subsystem: 'security',
            weight: 2,
            async run() {
              return {
                score: 30,
                status: 'critical',
                message: 'Media encryption is turned on but no company key is configured',
                technical:
                  'modules.enterprise-compliance.encryption.blobs=true but ports.keyWrapper is absent',
              };
            },
          });
        }
      }
      st.cleanups.push(holds.installStoreGuards(kernel));
      siem.attach();
      st.cleanups.push(() => siem.detach());
    },

    start(kernel) {
      const st = internals.get(kernel);
      if (!st) return;
      const { rt } = st;
      // Legal hold → lifecycle (all modules are registered by now).
      const lifecycleHolds = kernel.use<LifecycleHoldsLike>('lifecycle.holds');
      if (lifecycleHolds) st.cleanups.push(lifecycleHolds.register(st.holds.provider()));
      else rt.log('info', 'lifecycle module not present; legal hold uses the store guard only', {});
      const retentionProviders = kernel.use<RetentionProvidersLike>(LIFECYCLE_RETENTION_PROVIDERS);
      if (retentionProviders?.register)
        st.cleanups.push(retentionProviders.register(kernel.use(RETENTION_SERVICE) as never));

      st.gate = installApprovalGate(kernel.actions, st.approvals, rt);
      st.cleanups.push(() => st.gate?.uninstall());

      const checkRes = () => {
        st.residency = checkResidency(kernel.config(), rt.settings());
        for (const i of st.residency.filter((x) => x.severity === 'critical'))
          rt.log('error', 'data residency mismatch', { relayId: i.relayId, detail: i.technical });
      };
      checkRes();
      st.cleanups.push(
        kernel.onConfigChange(() => {
          checkRes();
          st.gate?.refresh();
          schedule();
        }),
      );

      const guard = (name: string, fn: () => Promise<unknown>) => async () => {
        try {
          await fn();
        } catch (err) {
          rt.log('error', `${name} failed`, { err: errMsg(err) });
        }
      };
      let interval = -1;
      const schedule = () => {
        const s = rt.settings().siem;
        if (s.intervalSeconds === interval) return;
        interval = s.intervalSeconds;
        kernel.ports.scheduler.every(
          JOBS.siem,
          interval,
          guard('SIEM export', () => st.siem.tick()),
        );
      };
      schedule();
      kernel.ports.scheduler.every(
        JOBS.reports,
        6 * 3600,
        guard('usage report', () => st.reports.tick()),
      );
      kernel.ports.scheduler.every(
        JOBS.gc,
        86400,
        guard('approvals cleanup', () => st.approvals.gc()),
      );
    },

    async stop(kernel) {
      const st = internals.get(kernel);
      for (const j of Object.values(JOBS)) kernel.ports.scheduler.cancel(j);
      if (!st) return;
      for (const c of st.cleanups.splice(0).reverse()) {
        try {
          c();
        } catch {}
      }
      await st.siem.close();
    },
  });
}

export const complianceModule: BeamhopModule = createComplianceModule();
