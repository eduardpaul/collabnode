import type { HistoryEntry, HistoryFilter } from "./ops.js";

export function cloneHistoryEntry(entry: HistoryEntry): HistoryEntry {
  return {
    ...entry,
    fields: entry.fields ? [...entry.fields] : undefined,
    changes: entry.changes?.map((change) => ({ ...change })),
  };
}

/** Indices of entries to drop so the newest `limit` by at/opId remain. Descending for safe removeAt. */
export function historyIndicesToDrop(entries: HistoryEntry[], limit: number): number[] {
  if (entries.length <= limit) {
    return [];
  }
  const ranked = entries.map((entry, index) => ({ entry, index }));
  ranked.sort((a, b) => {
    const cmp = compareHistory(a.entry, b.entry);
    return cmp !== 0 ? cmp : a.index - b.index;
  });
  return ranked
    .slice(0, ranked.length - limit)
    .map((item) => item.index)
    .sort((a, b) => b - a);
}

export function compareHistory(a: HistoryEntry, b: HistoryEntry): number {
  if (a.at < b.at) {
    return -1;
  }
  if (a.at > b.at) {
    return 1;
  }
  if (a.opId < b.opId) {
    return -1;
  }
  if (a.opId > b.opId) {
    return 1;
  }
  return 0;
}

export function selectHistory(entries: HistoryEntry[], filter?: HistoryFilter): HistoryEntry[] {
  let out = entries.map(cloneHistoryEntry);
  if (filter?.id) {
    out = out.filter((entry) => entry.id === filter.id);
  }
  if (filter?.actorId) {
    out = out.filter((entry) => entry.actorId === filter.actorId);
  }
  if (filter?.since) {
    out = out.filter((entry) => entry.at >= filter.since!);
  }
  out.sort(compareHistory);
  if (filter?.limit !== undefined) {
    out = out.slice(-filter.limit);
  }
  return out;
}

export function trimHistory(entries: HistoryEntry[], limit: number): HistoryEntry[] {
  const drop = new Set(historyIndicesToDrop(entries, limit));
  if (drop.size === 0) {
    return entries;
  }
  return entries.filter((_, index) => !drop.has(index));
}
