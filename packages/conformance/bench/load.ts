// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Load test (not run in CI): opens N connections with M subscriptions each and
 * publishes at a target rate, then reports achieved events/s, deliveries/s and
 * latency percentiles — to check the 10k connections / 5k events/s target.
 *
 *   bun bench/load.ts --url ws://127.0.0.1:8080 --conns 10000 --subs 2 --rate 5000 --duration 30
 *
 * Point it at a relay with generous rate limits (every publisher key posts
 * rate/keys events per second). Raise `ulimit -n` for many connections.
 */
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

interface Opts {
  url: string;
  conns: number;
  subs: number;
  rate: number;
  duration: number;
  publishers: number;
  keys: number;
  buckets: number;
  connectConcurrency: number;
}

function parse(argv: string[]): Opts {
  const o: Opts = {
    url: 'ws://127.0.0.1:8080',
    conns: 1000,
    subs: 1,
    rate: 500,
    duration: 10,
    publishers: 20,
    keys: 200,
    buckets: 100,
    connectConcurrency: 200,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!.replace(/^--/, '');
    const v = argv[++i];
    if (k === 'url') o.url = String(v);
    else if (k in o) (o as unknown as Record<string, number>)[k] = Number(v);
    else throw new Error(`unknown option --${k}`);
  }
  return o;
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(1) : '-';
}

function open(url: string, timeoutMs = 10_000): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error('timeout'));
    }, timeoutMs);
    ws.onopen = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('error'));
    };
  });
}

async function main() {
  const o = parse(process.argv.slice(2));
  const runTag = `load-${Date.now().toString(36)}`;
  const total = Math.ceil(o.rate * o.duration);
  console.log(
    `Target: ${o.conns} connections × ${o.subs} subs, ${o.rate} ev/s for ${o.duration}s (${total} events) → ${o.url}`,
  );

  // Pre-sign everything so signing cost does not limit the publish rate.
  const keys = Array.from({ length: o.keys }, () => generateSecretKey());
  const signStart = performance.now();
  const events = Array.from({ length: total }, (_, i) =>
    finalizeEvent(
      {
        kind: 1,
        created_at: Math.floor(Date.now() / 1000),
        content: `${runTag} #${i}`,
        tags: [
          ['t', runTag],
          ['b', `${runTag}-${i % o.buckets}`],
        ],
      },
      keys[i % keys.length]!,
    ),
  );
  console.log(`Signed ${total} events in ${fmt((performance.now() - signStart) / 1000)} s`);

  // ── Subscribers ──
  const sentAt = new Map<string, number>();
  const deliveryLat: number[] = [];
  let deliveries = 0;
  let notices = 0;
  let closedSubs = 0;
  let connectFailures = 0;
  const sockets: WebSocket[] = [];
  const connStart = performance.now();
  for (let i = 0; i < o.conns; i += o.connectConcurrency) {
    const batch = Array.from({ length: Math.min(o.connectConcurrency, o.conns - i) }, (_, j) =>
      open(o.url).then(
        (ws) => {
          const idx = i + j;
          ws.onmessage = (e) => {
            const s = String(e.data);
            if (s.startsWith('["EVENT"')) {
              deliveries++;
              const m = /"id":"([0-9a-f]{64})"/.exec(s);
              const t = m ? sentAt.get(m[1]!) : undefined;
              if (t !== undefined && deliveryLat.length < 2_000_000)
                deliveryLat.push(performance.now() - t);
            } else if (s.startsWith('["NOTICE"')) notices++;
            else if (s.startsWith('["CLOSED"')) closedSubs++;
          };
          for (let k = 0; k < o.subs; k++) {
            const bucket = (idx * o.subs + k) % o.buckets;
            ws.send(
              JSON.stringify([
                'REQ',
                `s${k}`,
                { kinds: [1], '#b': [`${runTag}-${bucket}`], limit: 0 },
              ]),
            );
          }
          sockets.push(ws);
        },
        () => {
          connectFailures++;
        },
      ),
    );
    await Promise.all(batch);
  }
  console.log(
    `Opened ${sockets.length}/${o.conns} connections in ${fmt((performance.now() - connStart) / 1000)} s (${connectFailures} failed)`,
  );

  // ── Publishers ──
  const pubs: WebSocket[] = [];
  const okLat: number[] = [];
  let accepted = 0;
  let rejected = 0;
  let lastEventAt = 0;
  const rejectReasons = new Map<string, number>();
  for (let i = 0; i < o.publishers; i++) {
    const ws = await open(o.url);
    ws.onmessage = (e) => {
      const s = String(e.data);
      if (!s.startsWith('["OK"')) return;
      const f = JSON.parse(s) as [string, string, boolean, string];
      const t = sentAt.get(f[1]);
      lastEventAt = performance.now();
      if (t !== undefined) okLat.push(lastEventAt - t);
      if (f[2]) accepted++;
      else {
        rejected++;
        const why = String(f[3]).split(':')[0] ?? '?';
        rejectReasons.set(why, (rejectReasons.get(why) ?? 0) + 1);
      }
    };
    pubs.push(ws);
  }

  const tickMs = 10;
  const perTick = o.rate / (1000 / tickMs);
  let carry = 0;
  let next = 0;
  const pubStart = performance.now();
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      carry += perTick;
      while (carry >= 1 && next < events.length) {
        carry -= 1;
        const ev = events[next]!;
        const ws = pubs[next % pubs.length]!;
        sentAt.set(ev.id, performance.now());
        ws.send(JSON.stringify(['EVENT', ev]));
        next++;
      }
      if (next >= events.length) {
        clearInterval(timer);
        resolve();
      }
    }, tickMs);
  });
  const pubSeconds = (performance.now() - pubStart) / 1000;
  // Drain: wait for OKs/deliveries to settle.
  const drainUntil = performance.now() + 10_000;
  let lastDeliveries = -1;
  while (performance.now() < drainUntil) {
    await new Promise((r) => setTimeout(r, 500));
    if (accepted + rejected >= total && deliveries === lastDeliveries) break;
    lastDeliveries = deliveries;
  }
  // Rates are measured from the first publish to the last OK received.
  const wall = (Math.max(lastEventAt, pubStart + 1) - pubStart) / 1000;

  okLat.sort((a, b) => a - b);
  deliveryLat.sort((a, b) => a - b);
  const expected = Math.round((accepted * sockets.length * o.subs) / o.buckets);
  console.log('');
  console.log(
    `Published:   ${next} events in ${fmt(pubSeconds)} s → ${fmt(next / pubSeconds)} ev/s sent`,
  );
  console.log(
    `Accepted:    ${accepted} (${fmt(accepted / wall)} ev/s), refused ${rejected}${rejectReasons.size ? ` ${JSON.stringify(Object.fromEntries(rejectReasons))}` : ''}`,
  );
  console.log(
    `OK latency:  p50 ${fmt(pct(okLat, 50))} ms, p95 ${fmt(pct(okLat, 95))} ms, p99 ${fmt(pct(okLat, 99))} ms`,
  );
  console.log(
    `Deliveries:  ${deliveries} of ~${expected} expected (${fmt(deliveries / wall)} msg/s)`,
  );
  console.log(
    `Delivery latency: p50 ${fmt(pct(deliveryLat, 50))} ms, p95 ${fmt(pct(deliveryLat, 95))} ms, p99 ${fmt(pct(deliveryLat, 99))} ms`,
  );
  console.log(`NOTICEs: ${notices}, CLOSED subs: ${closedSubs}`);
  const meets = sockets.length >= 10_000 && accepted / wall >= 5000 && pct(okLat, 95) < 1000;
  console.log(
    `\n10k connections / 5k ev/s target: ${meets ? 'MET' : 'not demonstrated by this run'}`,
  );

  for (const ws of [...sockets, ...pubs]) ws.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
