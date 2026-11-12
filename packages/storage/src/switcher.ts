import type {
  DatabaseInstanceInfo,
  DatabaseStateFile,
  DatabaseSwitcher,
  DatabaseTarget,
  Logger,
  SwitchableDb,
} from "@beamhop/sdk";
import type { SqliteOptions } from "./db";

export interface DatabaseSwitcherDeps {
  db: SwitchableDb;
  logger: Logger;
  /** the database the server runs on at startup */
  initial: DatabaseTarget;
  /** env vars pin the database: switching is refused */
  envPinned: boolean;
  /** postgres URL from env/config, offered as a prefill (unredacted; the switcher redacts it in views) */
  defaultPostgresUrl?: string;
  readState(): DatabaseStateFile | undefined;
  writeState(state: DatabaseStateFile): Promise<void>;
  /** live instances on the current database (heartbeats), including this one */
  instances(): Promise<DatabaseInstanceInfo[]>;
  /** audit entry; written to the database current at the time of the call */
  audit(entry: { actor: string; action: string; target: string | null; details: Record<string, unknown> }): Promise<void>;
  /** called after a successful switch (e.g. to update config.database) */
  onSwitched?(target: DatabaseTarget): void;
  /** longest write pause before the switch gives up and resumes on the old database; default 15000 ms */
  pauseBudgetMs?: number;
  sqlite?: SqliteOptions;
}

/** CONTRACT STUB: implemented on the switcher/admin branch. */
export function createDatabaseSwitcher(_deps: DatabaseSwitcherDeps): DatabaseSwitcher {
  throw new Error("not implemented");
}
