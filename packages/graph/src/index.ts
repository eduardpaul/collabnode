export type {
  EntityMeta,
  GraphEdgeRecord,
  GraphNodeRecord,
  GraphOp,
  GraphSnapshot,
  HistoryEntry,
  HistoryFieldDiff,
  HistoryFilter,
  PropertyMap,
  PropertyValue,
  Provenance,
  QueryResult,
  QueryRow,
} from "./ops.js";
export {
  applyPropertyPatch,
  diffSnapshots,
  emptyMeta,
  nodeTags,
  snapshotToOps,
  stampMeta,
} from "./ops.js";
export {
  cloneHistoryEntry,
  compareHistory,
  historyIndicesToDrop,
  selectHistory,
  trimHistory,
} from "./history.js";
export type { GraphSearchModes, GraphStore, WorkspaceScope } from "./store.js";
export { GraphStoreError, scopeKey } from "./store.js";
export type { EmbeddingProvider, GraphVectorRequest } from "./vector.js";
export {
  aboveFloor,
  cosineSimilarity,
  vectorProperties,
  vectorSlug,
  vectorText,
} from "./vector.js";
export type {
  GraphSearchHit,
  GraphSearchRequest,
  SearchableProperty,
} from "./search.js";
export {
  boostTiers,
  flattenSearchValue,
  fold,
  joinedTerms,
  searchTerms,
  searchableProperties,
  squash,
} from "./search.js";
export { InMemoryGraphStore } from "./memory.js";
export type { InMemoryGraphStoreOptions } from "./memory.js";
export { runMinimalQuery } from "./query.js";
