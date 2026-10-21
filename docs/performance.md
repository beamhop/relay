# Performance

Target per node (plan §3.5): 10,000 open connections and 5,000 incoming events per second.

## Signature checking threads

Every incoming post carries a signature that must be checked before it is stored. That
check is the most expensive step of accepting a post. On the Bun server it runs on
background threads, so a burst of posts does not hold up everyone else's connection.

- **Setting:** `node.verifyWorkers` ("Signature checking threads"), env
  `BEAMHOP_NODE__VERIFY_WORKERS`, or `beamhop serve --verify-workers <n>`.
  Empty = CPU cores − 1 (at least 1). `0` = check on the main thread.
- Duplicates are answered before any signature check.
- If a thread fails, the posts it was checking are refused with
  `invalid: could not verify the signature, please try again` (never accepted), and the
  thread is restarted. If threads keep failing, checks move back to the main thread.
- When too many posts are waiting (8,192), new ones are checked on the main thread
  instead of queueing further.
- Cloudflare Workers check signatures inline (one isolate per relay).

Technical: `ports.verifier` (`SignatureVerifier` in `@beamhop/core`) is implemented by
`VerifyPool` in `packages/runtime-bun/src/verify-pool.ts`: Bun `Worker`s running
`verify-worker.ts` (`@noble/curves` BIP-340), batches of up to 64 events (sent on the next
event-loop turn when a thread is idle, otherwise when one frees up, at most 1 ms later),
two batches in flight per thread, 10 s batch timeout = crash. Per-connection order of
`OK` replies is kept because the relay engine handles each connection's messages in
sequence. The single binary embeds the worker as an extra `bun build --compile`
entrypoint.

## Benchmark: signature checks

```bash
bun packages/runtime-bun/bench/verify.ts                     # 20k events
EVENTS=50000 WORKERS=1,2,4,8 bun packages/runtime-bun/bench/verify.ts
```

Events arrive in bursts of 64 per event-loop turn; a 1 ms timer measures event-loop lag
(how late it fires) while they are checked. The last line is JSON for CI:
`{"bench":"verify","inline_eps":…,"pool_eps":…,"loop_lag_p99_ms":…,…}`.

Measured 2026-10-21, Apple M-series laptop, 10 cores (default pool 9), Bun 1.4.3, 20k
events. The machine was shared with other jobs (load average ≈ 7), so treat these as
rough; three runs, ranges shown:

| mode          | events/s       | event-loop lag p99 |
|---------------|----------------|--------------------|
| main thread   | 3,000 – 3,950  | 18 – 37 ms         |
| 1 thread      | 2,250 – 3,500  | 0.2 – 0.9 ms       |
| 2 threads     | 3,550 – 6,050  | 0.2 – 1.8 ms       |
| 4 threads     | 6,800 – 8,500  | 0.2 – 2.4 ms       |
| 9 threads     | 10,100 – 11,900| 2.9 – 6.9 ms       |

Takeaways: one core checks ≈ 3.5–4k signatures/s, below the 5k ev/s target, and while
it does, the event loop stalls for ~20 ms at a time. With the pool the event loop stays
responsive and throughput scales with threads; at cores − 1 threads every core is busy,
so lag rises a little (still well under the main-thread figure).

## Load test

`scripts/bench/load.ts` tests the whole server end to end. It starts the real server with
the default SQLite storage, opens thousands of app connections, sends posts at a fixed
rate, and measures what the people on those connections get back.

```bash
bun run bench:load                                    # 10k connections, 5k posts/s, 30 s
bun run bench:load -- --conns 2000 --rate 1000 --duration 10
bun run bench:load -- --binary dist/beamhop-darwin-arm64   # the compiled single binary
bun run bench:load -- --url ws://127.0.0.1:3334            # a server that is already running
BENCH_SERVER_PROFILE=/tmp/prof bun run bench:load -- …      # CPU profile of the server (markdown)
```

The test runs in five steps:

1. **Sign posts first.** Every post is signed before the test starts, on worker threads,
   so signing does not slow down sending.
2. **Start the server.** It runs `packages/runtime-bun/src/main.ts` (or `--binary`) in its
   own process, on a free local port, with a temporary data folder. The generated settings
   file lifts the rate limits: every connection comes from 127.0.0.1, and per-address
   limits are tested elsewhere. Then `--history` posts (default 10,000) are stored, so the
   first feed requests read from real storage.
3. **Open the readers.** `--conns` reader connections are split across `--shards` client
   processes (default: cores − 2, at most 8). Each reader subscribes like an app does:
   - a follow feed: the notes of `--follows` people (default 5), with the last 10 from history;
   - its mentions: notes and reactions that tag it (`#p`);
   - for 20% of readers, one hashtag (`#t`).

   The test then waits until every subscription has sent its EOSE. A failed connect is
   retried up to 3 times; connects that still fail count as errors.
4. **Send posts.** `--rate` posts per second go out over `--publishers` connections (default
   50) for `--duration` seconds. 80% are notes and 20% are reactions. Every post mentions
   one reader, and 20% of notes carry a hashtag. Posts follow a fixed schedule: a late send
   is caught up, so its waiting time counts toward latency instead of being hidden.
5. **Measure.** The results are:
   - accepted posts per second;
   - `OK` latency p50/p95/p99, from send to the server's answer;
   - delivery latency p50/p95/p99, from send to arrival at each subscribed reader;
   - delivered/expected. The expected count is exact: every subscription of every
     connected reader that matches an accepted post;
   - errors: failed connects, missing EOSE, NOTICE or CLOSED, disconnects, posts with no
     `OK`, refusals;
   - server RSS (the peak too);
   - server event-loop lag (`--binary` runs report RSS only);
   - client event-loop lag, which shows when the clients themselves are the bottleneck.

Output is a table and then one JSON line, `{"bench":"load",...}`, also written to
`--json-out <file>` if you pass it. `--assert-target` exits with code 1 when the §3.5 target
is not met. The target counts as met when all of these hold: ≥ 10,000 connections,
≥ 98% of 5,000 posts/s accepted, `OK` p95 < 1 s, and ≥ 99% delivered.

**Many connections.** Bun raises the open-file limit at start-up. If connects fail anyway,
run `ulimit -n 65536`, and on Linux widen `net.ipv4.ip_local_port_range`. On macOS the
listen backlog is 128 (`kern.ipc.somaxconn`). For that reason the test opens at most
`--connect-concurrency` (default 64) connections at once across all client processes.

### Measured (2026-10-21)

All runs: Apple M-series laptop, 10 cores, Bun 1.4.3, server from source (SQLite, 9
signature threads), 8 client processes on the same machine. Other jobs were using the
machine the whole time (load average 10–20 of 10 cores), so these numbers are low and
should be repeated on a quiet machine or a dedicated server.

| Run | Connections | Posts/s sent → accepted | OK p95 | Delivery p95 | Delivered | Server RSS peak | Loop lag p99 |
|---|---|---|---|---|---|---|---|
| `--conns 2000 --rate 1000 --duration 10` | 2,000 | 1,000 → 1,000 | 13 ms | 13 ms | 100% | 157 MB | 11 ms |
| same, `--binary` (compiled) | 2,000 | 1,000 → 999 | 11 ms | 11 ms | 100% | 299 MB | – |
| `--conns 1000 --rate 3000 --duration 10 --history 0` | 1,000 | 3,000 → 2,445 | 2.3 s | 2.3 s | 100% | 225 MB | 19 ms |
| `--conns 10000 --rate 2000 --duration 30` | 10,000 | 2,000 → 1,297 | 9.7 s | 9.7 s | 100% of accepted | 357 MB | 31 ms |
| `bun run bench:load` (10k / 5k / 30 s) | 10,000 | 5,000 → 2,039 | 10.1 s | 10.1 s | 100% of accepted | 423 MB | 231 ms |

**The 10k connections / 5k posts per second target was not demonstrated.** What the runs
show:

- **Connections are not the limit.** 10,000 connections and 21,976 subscriptions open in
  about 1.5 s with no failures, and the server stays under 450 MB. Every accepted post
  reaches every matching subscription.
- **Accepting posts is the limit.** On this shared machine the server accepts about
  1.3–2.4k posts/s. A CPU profile of the server
  (`BENCH_SERVER_PROFILE`, 3k posts/s run) shows where the main thread's time goes:
  - **About 57% in synchronous `bun:sqlite` calls.** Most of it is the event store's group
    commit (`EventStore.flush`, `packages/storage-sql/src/events.ts`). Policy state writes
    for every post add more: `markSeen`/`markActive` → `docs.put`/`cas` in
    `packages/policy/src/state.ts`.
  - **About 14% in policy hooks.** This includes `PolicyModuleConfigSchema.parse` on every
    post, which runs when the module's config section is not already parsed.

  Signature checking runs on threads and is not the limit.
- **Beyond capacity, posts are lost without an answer.** Once a publisher connection has
  `maxPendingMessages` (256) messages waiting, further posts get a NOTICE but no `OK`. That
  is what `publisher_notice` / `missing_ok` count in the error detail.
- Next steps, to be made in the storage and policy packages:
  - move SQLite writes off the main thread (a writer worker);
  - fold the per-post policy state writes into the event store's group commit, or batch
    them in memory;
  - answer every refused post with `OK false`.

## Regression gate

`scripts/bench/gate.ts` (`bun run bench:gate`) runs four benchmarks, each in its own
process:

- the load test, CI-sized: 1,000 connections, 400 posts/s, 15 s, 2 client processes;
- the signature-check benchmark (`packages/runtime-bun/bench/verify.ts`);
- the SQLite ingest benchmark (`packages/storage-sql/bench/ingest.ts`, 30k events);
- the fan-out benchmark (`packages/relay/bench/fanout.ts`).

It compares the results with `scripts/bench/thresholds.json` and exits with code 1 when
any check fails. Results go to `<--out>/results.json` (default
`$TMPDIR/beamhop-bench-results`).

| Check | Fails when |
|---|---|
| `load.accepted_eps` ≥ 380 | the server cannot keep up with a fixed 400 posts/s |
| `load.ok_p95_ms`, `load.delivery_p95_ms` ≤ 200 | posts queue up |
| `load.delivered_ratio` ≥ 0.999, `load.errors` ≤ 0 | anything is lost, refused, dropped or disconnected |
| `load.server_rss_peak_mb` ≤ 450 | memory grows |
| `load.loop_lag_p99_ms` ≤ 60 | something blocks the event loop |
| `verify.inline_eps` ≥ 900, `verify.pool_eps` ≥ 800 | signature checks get slower |
| `storage.ingest_eps` ≥ 1,500, `storage.query_author_feed_ms` ≤ 6 | SQLite writes or the feed query get slower |
| `fanout.broadcast_eps` ≥ 20,000, `fanout.ingest_eps` ≥ 1,000 | subscription matching or engine ingest gets slower |

**How the thresholds were set.** They are absolute bounds for a 2-vCPU GitHub runner. Each
throughput floor is about 0.36 × the local value: one runner vCPU is roughly 0.6 of one
laptop core, and another factor of 0.6 leaves room for noise. Ceilings are the local value
divided by the same factor, then rounded up generously. They catch big regressions, such
as a synchronous call on the hot path or a memory leak, not 10% drift. The local values
are in the `_local` keys of the file. It was measured with `bun run bench:gate` on
2026-10-21:

- load test: 7.8 ms `OK` p95, 6.3 ms lag p99, 133 MB RSS;
- signature checks: 2,486 posts/s inline;
- SQLite ingest: 4,133 events/s;
- fan-out: 56k events/s broadcast, 2,873 events/s engine ingest.

**Changing the thresholds locally:**

```bash
BENCH_LOAD_OK_P95_MS_MAX=50 bun run bench:gate --only load   # one bound
BENCH_SCALE=2 bun run bench:gate                             # min × 2, max ÷ 2 (fast machine)
BENCH_THRESHOLDS=my-thresholds.json bun run bench:gate        # another file
BENCH_PROFILE=full bun run bench:gate                         # 10k connections / 5k posts/s
```

**In CI.** The `bench` job in `.github/workflows/ci.yml` runs the gate:

- on pushes to `main`;
- on pull requests that touch `packages/relay`, `packages/storage-sql`,
  `packages/runtime-bun`, `packages/core` or `scripts/bench`.

It uploads `results.json` as the `bench-results` artifact. After a deliberate change in
performance, update `thresholds.json` and its `_local` notes in the same pull request.
