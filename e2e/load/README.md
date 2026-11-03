# Load, soak and resilience tools

Black-box tools that run beamhop as a separate process (`server-proc.ts`, a real `startServer` with the CLI's signal
handling) on a throwaway data dir and a random port, and drive it over websockets / HTTP. All clients connect from
127.0.0.1, so the server is started with an IP allow rule for it and the per-IP limits lifted (as for a trusted
importer); store benchmarks authenticate as the relay owner so the per-address read budgets don't measure the rate
limiter. Numbers are indicative: client and server share the machine.

Postgres runs use `postgres://beamhop:beamhop@127.0.0.1:5432/load_tests` (`--pg-url` to change), whose `public`
schema is **dropped** at the start of each scenario.

```bash
# throughput / latency / fan-out / connections / blossom / historical queries / COUNT / NIP-77, per backend
bun e2e/load/bench.ts --db sqlite,postgres
bun e2e/load/bench.ts --db sqlite --only query,count,neg --corpus 1000000 --corpus-dir /tmp/beamhop-corpus

# mixed workload for N minutes, sampling memory, descriptors, connections, subscriptions, database size
bun e2e/load/soak.ts --db sqlite --minutes 30 --rate 200 --idle 300

# kill -9 / SIGTERM under write load, postgres stopped mid-run (own initdb cluster), disk full (macOS disk image)
bun e2e/load/resilience.ts --db sqlite,postgres --cycles 5
```

`LOAD_REPORT=path.md` writes the markdown tables to a file as well.

| file | what |
| --- | --- |
| `bench.ts` | `write` (EVENT → OK throughput and latency, with and without `server.verifyWorkers`), `fanout` (live delivery to many subscribers), `conns` (thousands of open connections), `blossom` (upload / download concurrency), `query` / `count` / `neg` on a seeded corpus (plus the store's query plans) |
| `soak.ts` | idle subscribers, writers (notes, reactions, replaceable, ephemeral, deletions), connection churn (a quarter dropped without a close frame), COUNT / NEG-OPEN, and slow consumers (raw sockets that subscribe to everything, then stop reading) |
| `resilience.ts` | every EVENT answered `OK true` must be stored afterwards; sqlite `integrity_check`, FTS integrity, no orphaned tag rows |
| `lib/seed.ts` | deterministic synthetic corpus (Zipf-like authors, notes / reactions / reposts / comments with `e` `p` `t` tags, a year of timestamps), bulk-inserted with placeholder signatures |
| `server-proc.ts` | the server process; `LOAD_STATS_MS` prints memory / fd / JSC object counts, `LOAD_SEED` seeds and exits, `LOAD_EXPLAIN` prints query plans and exits |

`--corpus-dir` keeps the seeded corpus (sqlite: the database file; postgres: the seed time, the data stays in
`load_tests`) so later runs skip the minutes of seeding.
