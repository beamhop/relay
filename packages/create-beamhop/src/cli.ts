#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { main } from './index.ts';

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
