#!/usr/bin/env node

import fs from 'fs'
import { execSync } from 'child_process'

const force = process.argv.includes('--force')

if (execSync('git status --porcelain', { encoding: 'utf8' }).trim() && !force) {
  console.error('Error: Git working tree is dirty. Please commit or stash your changes first, or re-run with --force.')
  process.exit(1)
}

// One entry per directory under ../welshman/packages.
const packages = [
  'app',
  'content',
  'domain',
  'editor',
  'feeds',
  'lib',
  'net',
  'signer',
  'store',
  'util',
]

// pnpm 11 no longer reads the `pnpm` field in package.json, so overrides live in the workspace
// file. They are written for the install and reverted straight after: a committed link: override
// points every clone and every ci run at a checkout that only exists on one machine.
const file = 'pnpm-workspace.yaml'
const workspace = fs.readFileSync(file, 'utf8')

if (!/^overrides:$/m.test(workspace)) {
  console.error(`Error: ${file} has no \`overrides:\` block to link welshman into.`)
  process.exit(1)
}

const links = packages
  .map(name => `  '@welshman/${name}': link:../welshman/packages/${name}`)
  .join('\n')

// Other packages worth linking now and then:
//   '@pomade/core': link:../pomade/packages/core
//   nostr-editor: link:../nostr-editor
//   nostr-signer-capacitor-plugin: link:../nostr-signer-capacitor-plugin

fs.writeFileSync(file, workspace.replace(/^overrides:$/m, `overrides:\n${links}`))

try {
  execSync('pnpm i', { stdio: 'inherit' })
} finally {
  // Restore what was read rather than checking the file out, so any unrelated edits survive.
  fs.writeFileSync(file, workspace)
  execSync('git checkout -f pnpm-lock.yaml', { stdio: 'inherit' })
}

console.log('\nWelshman is linked. pnpm will warn that node_modules is out of sync until you')
console.log('run `pnpm i` again, which unlinks it.')
