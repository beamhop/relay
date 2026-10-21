// SPDX-License-Identifier: AGPL-3.0-or-later
// Worker entry for the optional workerd-based tests (`bun run test:cf`).
import { defineModule } from '@beamhop/core';
import { createCloudflareRuntime } from '../src/index.ts';

/** Echo handler standing in for the relay engine; keeps a counter in conn.state. */
const echo = defineModule({
  id: 'echo',
  register(kernel) {
    kernel.http.get('/hello', (c) => c.text(`hello ${c.var.route.relayId}`));
    kernel.ws = {
      onOpen(conn) {
        conn.state.set('echo', { n: 0 });
      },
      onMessage(conn, raw) {
        const s = conn.state.get('echo') as { n: number };
        s.n++;
        conn.send(JSON.stringify({ n: s.n, raw, authed: [...conn.authed] }));
        if (raw.startsWith('AUTH ')) conn.authed.add(raw.slice(5));
      },
      onClose() {},
    };
  },
});

const runtime = createCloudflareRuntime({ modules: [echo] });

export default runtime.worker;
export class RelayRoom extends runtime.RelayRoom {}
