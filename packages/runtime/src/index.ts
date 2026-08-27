export {
  CollabSession,
  Workspace,
  BatchBuilder,
  normalizedIdentityMatch,
  type ApplyOpsResult,
  type CollabSessionOptions,
  type GraphOpInput,
  type MutationOptions,
  type NodeRef,
  type UpsertEdgeInput,
  type UpsertNodeInput,
} from "./session.js";
export { compileTemplate, validateParams, type WorkspaceType } from "@collabnode/schema";

export { SnapshotIndex } from "./snapshot-index.js";
export { Projector, CRDT_PROJECT_DEBOUNCE_MS, type ProjectorListener } from "./projector.js";
export {
  assertEdgeOp,
  assertEdgeOpWith,
  assertNodeOp,
  coerceProperties,
  normalizeTags,
} from "./validate.js";
export { applyDerivedProperties } from "./derived.js";
export { redactHistoryValue } from "./history.js";
export {
  bindGraphTools,
  compactSnapshot,
  deleteGraphEdge,
  deleteGraphNode,
  graphActors,
  graphChanges,
  graphDescribe,
  graphGet,
  graphHistory,
  graphList,
  graphNeighbors,
  graphQuery,
  graphSearch,
  graphSimilar,
  graphSnapshot,
  graphApplyBatch,
  graphDiffSince,
  resolveEntity,
  resolveNodeRef,
  upsertGraphEdge,
  upsertGraphNode,
  clampLimit,
  DEFAULT_LIST_LIMIT,
  LONG_STRING_LIMIT,
  MAX_LIST_LIMIT,
  MIN_ID_PREFIX,
  type BindGraphToolsOptions,
  type BoundGraphTools,
  type GraphActorsResult,
  type GraphChangeEvent,
  type GraphChangesArgs,
  type GraphChangesResult,
  type GraphDeleteResult,
  type GraphDescribeResult,
  type GraphEdgeWriteResult,
  type GraphGetArgs,
  type GraphHistoryArgs,
  type GraphListArgs,
  type GraphListResult,
  type GraphNeighborsArgs,
  type GraphNodeRef,
  type GraphNodeWriteResult,
  type GraphPropertyContract,
  type GraphQueryArgs,
  type GraphSearchArgs,
  type GraphSimilarArgs,
  type GraphSearchResult,
  type GraphSnapshotArgs,
  type SearchMatch,
  type UpsertGraphEdgeInput,
} from "./tools.js";

export type { GraphSearchModes } from "@collabnode/graph";
export { walk, type WalkDirection, type WalkHop, type WalkOptions, type WalkResult } from "@collabnode/graph";
export {
  snapshotToMarkdown,
  diffSnapshotsToMarkdown,
  type SnapshotMarkdownOptions,
} from "./snapshot-format.js";
