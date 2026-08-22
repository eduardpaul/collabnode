# Benchmark results

**Date:** 2026-08-20  
**Harness:** `@collabnode/bench` (`pnpm bench`)  
**Host:** WSL2, Linux 6.6, Intel Core i7-10870H (16 threads), 8 GiB RAM, Node 24.15.0  
**Apache AGE:** `apache/age:latest` (PostgreSQL 18.1) on `127.0.0.1:5455` via `examples/age-board` Compose  
**Fluid:** Tinylicious, local

These numbers are from this machine and this AGE container. They are not a SLA. Re-run with the commands in each section.

## Verdict

The CRDT is the source of truth. Memory and Ladybug/AGE are **projections**. All tested CRDT × store combinations stay consistent at small scale. **25 concurrent in-process users on Apache AGE stay consistent** (snapshot and Cypher agree, lag p99 17 ms). Ladybug hits a **process-local ceiling around 4 in-process databases** (mmap), which is a Ladybug limit, not a CRDT failure. AGE write throughput at 25 users is about **100 ops/s**, versus about **280 ops/s** for an in-memory projection at the same concurrency.

## What “ok” means

| Scenario | Pass rule |
| --- | --- |
| Hot path (`writes`, `concurrency`, `lag`, `snapshot`, `join`) | No errors; samples recorded |
| `users` | Every peer’s **snapshot and query** see all writes; lag p99 under budget |
| `limits` | Host snapshot and query match the seeded graph; a **joiner** sees the same nodes and edges |

Lag budgets: in-memory 250 ms, Ladybug 500 ms, AGE 1.5 s, Fluid (any store) 3 s.

Each peer is one `init()` with its **own** projection (one Ladybug file or one AGE graph). Two projectors on the same AGE graph duplicate edges. Fluid peers share one document; AGE/Ladybug do not share storage.

## Automated functional matrix

`packages/bench/tests/functional.test.ts` runs, when the native/store is present:

| CRDT | Store | Two-peer share + Cypher | Users ladder | Size / join |
| --- | --- | --- | --- | --- |
| memory | memory | pass | 4 users | 20 nodes |
| memory | ladybug | pass | 2 users (4 exhausts Ladybug) | 20 nodes |
| memory | age | pass (live AGE) | 2 users in CI-sized run; 25 in the CLI sweep below | 20 nodes |
| fluid | memory | pass | 2 users | 8 nodes |
| fluid | ladybug | pass | 2 users | 8 nodes |
| fluid | age | pass (live AGE) | 2 users | 8 nodes |

Earlier CLI matrix (`--matrix --scenario users,limits --ops 8 --concurrency 2 --size 20`) was **12/12 ok** for memory/fluid × memory/ladybug.

Harbor Lanes (`examples/age-board`) also checked two peers plus a 2-hop AGE Cypher (`Shipment → Hub → inland Hub`). That path is not supported by the in-memory query parser.

## Hot path — memory CRDT + Apache AGE

```bash
pnpm bench -- --graph age --ops 200 --concurrency 4 --size 200
```

| Scenario | ops/s | p50 | p99 | n | errors | ok |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| writes | 276 | 3.38 ms | 4.86 ms | 200 | 0 | ok |
| concurrency (4 writers) | 207 | 16.4 ms | 34.7 ms | 200 | 0 | ok |
| lag | — | 4.91 ms | 6.88 ms | 200 | 0 | ok |
| snapshot | — | 0.007 ms | 0.01 ms | 100 | 0 | ok |
| join (5 joins @ 200 nodes) | — | 170 ms | 175 ms | 5 | 0 | ok |

AGE `MERGE` dominates writes (~3 ms). Snapshot is the in-process CRDT, so it stays cheap. Join is opening a new AGE graph and projecting the snapshot.

## Hot path — Fluid + Apache AGE

```bash
pnpm bench -- --backend fluid --graph age --ops 40 --concurrency 2 --size 40 --port 7077
```

| Scenario | ops/s | p50 | p99 | n | errors | ok |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| writes | 125 | 7.52 ms | 14.8 ms | 40 | 0 | ok |
| concurrency (2 writers) | 118 | 15.0 ms | 25.4 ms | 40 | 0 | ok |
| lag | — | 9.21 ms | 12.6 ms | 40 | 0 | ok |
| snapshot | — | 0.37 ms | 1.48 ms | 100 | 0 | ok |
| join | — | 126 ms | 133 ms | 5 | 0 | ok |

Fluid adds roughly 2× write latency on top of AGE compared with the in-process CRDT (7.5 ms vs 3.4 ms p50). Replication lag stayed ~9–13 ms, far under the 3 s Fluid budget.

## Concurrent users

`users` splits `--ops` across `--concurrency` writers (`floor(ops / concurrency)` each), then ladders 1, 2, 4, … up to the max.

### Memory CRDT + AGE, through 25 users

```bash
pnpm bench -- --graph age --scenario users --ops 250 --concurrency 25
```

Ten writes per user at the top of the ladder (25 × 10 = 250 tasks). Every row: 0 errors, snapshot **and** AGE query matched.

| Users | ops/s | lag p50 | lag p99 | writes | ok |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 232 | 3.07 ms | 3.90 ms | 10 | ok |
| 2 | 277 | 5.48 ms | 6.03 ms | 20 | ok |
| 4 | 227 | 5.60 ms | 5.89 ms | 40 | ok |
| 8 | 198 | 6.29 ms | 6.77 ms | 80 | ok |
| 16 | 128 | 11.1 ms | 12.7 ms | 160 | ok |
| **25** | **99.4** | **15.4 ms** | **17.1 ms** | **250** | **ok** |

### In-memory projection, same ladder (baseline)

```bash
pnpm bench -- --graph memory --scenario users --ops 250 --concurrency 25
```

| Users | ops/s | lag p50 | lag p99 | ok |
| ---: | ---: | ---: | ---: | --- |
| 1 | 4 840 | 0.09 ms | 0.13 ms | ok |
| 2 | 10 501 | 0.26 ms | 0.27 ms | ok |
| 4 | 4 439 | 0.37 ms | 0.40 ms | ok |
| 8 | 1 995 | 0.98 ms | 7.49 ms | ok |
| 16 | 546 | 2.89 ms | 3.12 ms | ok |
| 25 | 277 | 6.88 ms | 7.54 ms | ok |

At 25 users AGE is about **3× slower** on writes (~100 vs ~277 ops/s) and about **2×** on lag (17 ms vs 7.5 ms). Both pass.

Throughput falls as user count rises because **each peer projects every write**, not only its own. Twenty-five users × 10 writes → 250 CRDT nodes, and **each of the 25 AGE graphs applies those 250 `MERGE`s**.

### Smaller AGE user/size sweep (4 users, 200 nodes)

```bash
pnpm bench -- --graph age --scenario users,limits --ops 40 --concurrency 4 --size 200
```

| Scenario | param | ops/s | p50 | p99 | ok |
| --- | --- | ---: | ---: | ---: | --- |
| users | 1u | 220 | 3.39 ms | 4.14 ms | ok |
| users | 2u | 256 | 5.05 ms | 6.21 ms | ok |
| users | 4u | 212 | 6.30 ms | 7.13 ms | ok |
| limits | 100n | — | 0.005 ms | 0.03 ms | ok |
| limits | 200n | — | 0.06 ms | 0.13 ms | ok |

`limits` p50/p99 here are **snapshot** times after seed, not write latency. Host query and joiner query both matched the seeded Task/BLOCKS graph.

## App limits found

1. **Ladybug, in-process, ~4 databases.** Four concurrent `Database` handles in one Node process can throw `Buffer manager exception: Mmap for size … failed`. Two users on Ladybug passed. Treat that as a **Ladybug process-local limit**. Functional tests therefore cap Ladybug (and Fluid) at 2 users unless you put each DB in its own process.
2. **Apache AGE, 25 in-process peers: no such ceiling on this host.** 25 Postgres connections and 25 graphs stayed consistent. Postgres `max_connections` (default 100) is the next place to watch, not mmap.
3. **Do not share one AGE graph across two projectors.** That duplicates relationships. One graph name per `init()` peer.
4. **AGE cannot use vertex `id` for collab identity.** AGE’s `id` is the internal graphid. Collab node/edge ids are stored as `collabId`.
5. **Fluid + 25 users was not swept.** Fluid + AGE was verified at 2 concurrent writers. Expect extra lag from Tinylicious/Azure on top of the AGE table, still under the 3 s Fluid budget if this 2-user run is representative.
6. **Size ladder on AGE stopped at 200 nodes** in these runs (not 5 000). Snapshot stayed sub-millisecond; join at 200 nodes was ~170 ms (AGE graph create + project). Larger graphs will cost more on join and on each peer’s full projection.

## Conclusions

1. **Functional model holds.** YAML schema → CRDT (memory or Fluid) → projection (memory, Ladybug, or AGE). Peers agree when you check both snapshot and Cypher, including Fluid × AGE.
2. **25 concurrent AGE users is a working in-process size** on this laptop: ~100 writes/s, ~17 ms lag p99, full query agreement. That is an application-level number for “how many Node agents/users can share one document with an AGE projection,” not browser-tab Fluid scale-out.
3. **AGE is the slow projection, Fluid is the slow CRDT.** Memory+AGE writes ~3 ms; Fluid+AGE writes ~8 ms. Snapshots stay on the CRDT and stay fast. Joins pay for a new projection.
4. **Ladybug and AGE scale differently.** Ladybug is a fast local file but few in-process DBs. AGE is network SQL, slower per write, and tolerated 25 in-process peers here.
5. **Plan capacity on projection fan-out.** *N* users × *M* writes ≈ *N* × *M* `MERGE`s **per peer**. Raising concurrency without lowering work-per-user multiplies AGE load, not just CRDT load.
6. **Use AGE when you need real openCypher** (multi-hop, the Harbor Lanes query). Use memory when you only need `MATCH (n:Type)` / one-hop and want maximum ops/s. Use Ladybug when you want local Cypher and can keep **one DB per OS process**.

## Reproduce

```bash
pnpm build
pnpm --filter @collabnode/example-age-board compose:up

pnpm bench -- --graph age --ops 200 --concurrency 4 --size 200
pnpm bench -- --graph age --scenario users --ops 250 --concurrency 25
pnpm bench -- --graph memory --scenario users --ops 250 --concurrency 25
pnpm bench -- --backend fluid --graph age --ops 40 --concurrency 2 --size 40
pnpm --filter @collabnode/bench test   # functional matrix; skips AGE/Ladybug if missing
```
