// SPDX-License-Identifier: AGPL-3.0-or-later
// beamhop CLI generated from the action registry, plus init/doctor/backup/update
export { runCli, mainHelp, BUILTIN_COMMANDS } from './cli.ts';
export { type CliContext, defaultContext, resolveTarget, connect } from './context.ts';
export { BufferIo, type Io, processIo, CliError, UsageError, EXIT } from './io.ts';
export { parseFlags, type FlagSpec } from './args.ts';
export {
  type Catalog,
  type CatalogEntry,
  type JsonSchema,
  actionFields,
  actionHelp,
  buildInput,
  matchAction,
  GLOBAL_FLAGS,
} from './catalog.ts';
export { type AdminClient, kernelClient, remoteClient, apiRoot } from './client.ts';
export { bootLocal, serverRunning } from './local.ts';
export { completionScript, completionTree } from './commands/completion.ts';
export {
  runDoctor,
  defaultProbes,
  doctorExitCode,
  type DoctorProbes,
  type Finding,
} from './commands/doctor.ts';
export { renderInitYaml, type InitAnswers } from './commands/init.ts';
export { compareVersions, type ReleaseManifest } from './commands/update.ts';
export { createSnapshot, inspectSnapshot, restoreSnapshot } from './snapshot.ts';
export { readCredentials, credentialsPath } from './credentials.ts';
