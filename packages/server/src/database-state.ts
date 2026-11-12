import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { DatabaseStateFile } from "@beamhop/sdk";

const TargetSchema = z.discriminatedUnion("driver", [
  z.object({ driver: z.literal("sqlite"), sqlitePath: z.string().min(1), postgresUrl: z.string().optional() }),
  z.object({ driver: z.literal("postgres"), postgresUrl: z.string().min(1), sqlitePath: z.string().optional() }),
]);

const StateSchema = z.object({
  version: z.literal(1),
  current: TargetSchema,
  rollbacks: z
    .array(
      z.object({
        id: z.string().min(1),
        target: TargetSchema,
        frozenAt: z.number(),
        replacedBy: z.enum(["sqlite", "postgres"]),
      }),
    )
    .default([]),
  switchedAt: z.number().optional(),
});

/** Validates parsed JSON as a database state file. Throws with every issue listed. */
export function parseDatabaseState(json: unknown, source = "database state"): DatabaseStateFile {
  const parsed = StateSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid database state file ${source}:\n${issues}`);
  }
  return parsed.data as DatabaseStateFile;
}

/** Reads the database state file (config.database.stateFile); undefined when absent. Throws on a corrupt file. */
export function readDatabaseState(path: string): DatabaseStateFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`failed to read database state file ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`failed to parse database state file ${path}: ${(err as Error).message}`);
  }
  return parseDatabaseState(json, path);
}

/** Writes the state file atomically (tmp + fsync + rename), owner-only (0600), creating its directory (0700). */
export async function writeDatabaseState(path: string, state: DatabaseStateFile): Promise<void> {
  const valid = parseDatabaseState(state, path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  try {
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(valid, null, 2)}\n`, "utf8");
      await fh.chmod(0o600); // umask can't loosen it, but be explicit
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await chmod(path, 0o600);
  // persist the rename itself
  try {
    const dh = await open(dirname(path), "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* directory fsync is not supported everywhere */
  }
}
