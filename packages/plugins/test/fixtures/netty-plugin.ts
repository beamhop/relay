// SPDX-License-Identifier: AGPL-3.0-or-later
// Test fixture: asks for the network permission.
import { definePlugin } from '../../src/sdk/index.ts';

export default definePlugin({
  id: 'netty',
  name: 'Needs network',
  description: 'Test fixture',
  permissions: ['network'],
  onEvent() {
    return undefined;
  },
});
