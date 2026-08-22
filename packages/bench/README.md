# @collabnode/bench

**Private — not published to npm.** Performance harness for [collabnode](https://github.com/eduardpaul/collabnode).

Measures hot-path metrics (writes/s, concurrent peers, replication lag, snapshot, join) and runs functional ladders across CRDT × projection combinations.

```bash
pnpm build
pnpm bench                                          # memory + memory, hot path
pnpm bench -- --backend fluid --graph ladybug --scenario users --ops 40 --concurrency 8
pnpm bench -- --matrix --scenario users,limits --ops 16 --concurrency 4 --size 100
pnpm bench -- --json
```

`users` passes when every peer's snapshot **and** query see all writes and lag p99 stays under budget (memory 250 ms, ladybug 500 ms, age 1.5 s, fluid/hocuspocus 3 s). `limits` passes when snapshot, query, and a joiner all see the seeded graph.

`--matrix` runs memory/fluid/hocuspocus × memory/ladybug/age, skipping ladybug if `@ladybugdb/core` is missing and age if PostgreSQL+AGE is down. `--graph age` needs Apache AGE on `127.0.0.1:5455`.

See [benchmark_results.md](../../benchmark_results.md) for recorded runs.

---

MIT © Eduard Paul
