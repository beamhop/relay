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
