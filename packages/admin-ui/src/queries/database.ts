import { useQuery } from "@tanstack/react-query";
import type {
  DatabaseRollbackDeleteBody,
  DatabaseStatusResponse,
  DatabaseSwitchBody,
  DatabaseSwitchJobView,
  DatabaseSwitchPhase,
  DatabaseTarget,
  DatabaseTestResult,
} from "@beamhop/sdk/admin-contract";
import { api, enc } from "@/lib/api";
import { PAUSED_PHASES } from "@/lib/database";

export const DATABASE_KEY = ["database"] as const;

const TERMINAL: ReadonlySet<DatabaseSwitchPhase> = new Set(["done", "failed", "cancelled"]);
export const isTerminal = (phase: DatabaseSwitchPhase) => TERMINAL.has(phase);

export const useDatabaseStatus = () =>
  useQuery({
    queryKey: DATABASE_KEY,
    queryFn: () => api.get<DatabaseStatusResponse>("/database"),
    // row counts can be slow to gather on a big database; don't refetch on every focus
    refetchOnWindowFocus: false,
    retry: false,
  });

/** Polls a switch job every second (twice a second while writes are paused) until it ends. */
export const useSwitchJob = (id: string | undefined, initial?: DatabaseSwitchJobView) =>
  useQuery({
    queryKey: ["database", "job", id],
    queryFn: () => api.get<DatabaseSwitchJobView>(`/database/switch/${enc(id!)}`),
    enabled: !!id,
    initialData: initial && initial.id === id ? initial : undefined,
    refetchInterval: (q) => (!q.state.data ? 1000 : isTerminal(q.state.data.phase) ? false : PAUSED_PHASES.has(q.state.data.phase) ? 500 : 1000),
    // a poll may hit the moment writes are paused; keep showing the last view and try again
    retry: 3,
    staleTime: 0,
  });

export const databaseApi = {
  test: (target: DatabaseTarget) => api.post<DatabaseTestResult>("/database/test", { target }),
  start: (body: DatabaseSwitchBody) => api.post<DatabaseSwitchJobView>("/database/switch", body),
  cancel: (id: string) => api.post<{ cancelled: boolean }>(`/database/switch/${enc(id)}/cancel`),
  deleteRollback: (id: string, body: DatabaseRollbackDeleteBody) => api.del<{ ok: true }>(`/database/rollback/${enc(id)}`, body),
};
