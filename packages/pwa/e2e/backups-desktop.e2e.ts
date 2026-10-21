// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop parity (§6.14): Settings → Backups and restore. */
import { test } from '@playwright/test';
import { backupsSpecs } from './backups.shared.ts';

backupsSpecs(test);
