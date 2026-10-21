// SPDX-License-Identifier: AGPL-3.0-or-later
/** `import x from '….wasm' with { type: 'file' }` (Bun): the file's path. */
declare module '*.wasm' {
  const path: string;
  export default path;
}
