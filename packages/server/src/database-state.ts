import type { DatabaseStateFile } from "@beamhop/sdk";

/** Reads the database state file (config.database.stateFile); undefined when absent. Throws on a corrupt file. CONTRACT STUB. */
export function readDatabaseState(_path: string): DatabaseStateFile | undefined {
  return undefined;
}

/** Writes the state file atomically (tmp + rename), owner-only (0600), creating its directory (0700). CONTRACT STUB. */
export async function writeDatabaseState(_path: string, _state: DatabaseStateFile): Promise<void> {
  throw new Error("not implemented");
}
