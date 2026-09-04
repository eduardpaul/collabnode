---
"@collabnode/loro": minor
"@collabnode/collab": minor
"@collabnode/runtime": minor
"@collabnode/hub": minor
"@collabnode/hocuspocus": minor
"@collabnode/fluid": minor
"@collabnode/web": minor
"@collabnode/cli": minor
"collabnode": minor
---

Add `@collabnode/loro`, a third collab backend, and the versioning seam it needs.

Fluid and Hocuspocus give a document that is always *now*. Neither can say what
version it is at, what changed since a version, or what it looked like then —
which is why `history()` is a hand-rolled array kept inside the replicated
document and capped by `historyLimit`, why the projector re-derives every change
by comparing two whole snapshots, and why `hub.reopen` replays an artifact's
snapshot into a fresh document rather than reopening the document.

Loro keeps a DAG of the edits behind the document, so it can answer all three.

**The seam.** `CollaborativeGraph` gains four optional members — `version()`,
`diffSince(from, to?)`, `exportDoc(mode?)` and `checkout(version)` — narrowed
with `isVersioned(graph)`, plus `CollabBackend.restore(bytes, schema)`.
`CollabBackendCapabilities` gains `versioning`, declared rather than discovered
like the other three; it is `false` on memory, Hocuspocus and Fluid, which are
otherwise unchanged. `CollabSession` exposes `version()`, `exportDoc()` and
`checkout()`, the first two returning `undefined` where unsupported and the
third throwing with the reason.

**What it changes where it is present.** `Projector` asks the document what
changed instead of walking two snapshots, falling back when `diffSince` returns
`undefined` — which is not the same as `[]`, and the difference is a projection
going stale. `WorkspaceArtifact` gains `bytes` and `documentVersion`, so
`hub.reopen(artifact)` is a checkout with the workspace's own history rather
than a re-seed, and `hub.reopen(artifact, { at })` mounts it rewound;
`createHub({ artifactExport: "shallow" })` trades that for much smaller
artifacts. On Loro, `history()` rides the edit DAG instead of the document and
is not capped by `historyLimit`.

**What it costs.** Loro ships no transport, so the backend is in-process with
optional persistence (`{ kind: "loro", dir }`, or any `LoroDocStore`). Browser
peers still need Hocuspocus or Fluid, and `@collabnode/web` says so instead of
failing obscurely. `LoroCollaborativeGraph` exposes `exportUpdate`,
`importUpdate` and `onLocalUpdate` so a relay can be built on it.

`collabnode --backend loro [--docs <dir>]` now works instead of reporting that
Loro is reserved.
