# Validation scripts

Evidence for §2 and §16 of [ephemeral-workspaces.md](../ephemeral-workspaces.md).
Run `pnpm build` first; each script imports the built `dist/` output by absolute
path.

| Script | Answers |
| --- | --- |
| `churn.mjs` | Cold start per workspace, per-node vs. batch seed, with and without projection |
| `scaling.mjs` | Does template seeding scale linearly or quadratically? |
| `residency.mjs` | Do closed workspaces go away, unpersisted? |
| `persisted.mjs` | Does anything remove a terminated workspace, persisted? |
| `fluid.mjs` | Fluid container cold start (spawns Tinylicious on :7070) |

```bash
pnpm build
node docs/design/validation/churn.mjs          # ITER/TEMPLATE/WRITES env overrides
node docs/design/validation/scaling.mjs
```

`scaling.mjs` and `churn.mjs` now measure the before and the after in one run:
each reports the per-node `upsertNode` loop alongside the `applyOps` batch path,
so the numbers in §16.2 can be reproduced rather than taken on trust.

`persisted.mjs` is the regression guard for the privacy defect in §2.3. It ends
by reopening a terminated workspace by id and printing what it reads back; that
line must say `nothing left`.

These should be promoted into `packages/bench` as a `churn` scenario — cold start
and seed cost are product-defining numbers for the ephemeral-workspace direction
and deserve a permanent regression guard.
