// SPDX-License-Identifier: AGPL-3.0-or-later
/** Desktop parity: write a plugin from a description (§6.5.4). */
import { test } from '@playwright/test';
import { pluginWriterSpecs } from './plugin-writer.shared.ts';

pluginWriterSpecs(test);
