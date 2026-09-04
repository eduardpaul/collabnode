import type { HistoryEntry, HistoryFilter } from "@collabnode/graph";
import { selectHistory } from "@collabnode/graph";
import type { LoroDoc } from "loro-crdt";

/**
 * History rides the DAG, in commit messages, rather than living in the document.
 *
 * The Yjs and Fluid backends keep a parallel array of `HistoryEntry` JSON
 * *inside* the replicated document, decode the whole of it on every write to
 * decide what to evict, and cap it at `historyLimit` — so a long-lived
 * workspace loses its oldest history to a constant that has nothing to do with
 * the application. Here the entries are attached to the change that made them:
 * nothing is stored twice, nothing is scanned per write, and history is
 * retained for exactly as long as the history the document already keeps.
 *
 * `historyLimit` is therefore not honoured by this backend, and does not need
 * to be: `exportDoc("shallow")` is the eviction, and it drops the ops and their
 * entries together instead of leaving one without the other.
 */
export function encodeHistoryMessage(entries: HistoryEntry[]): string | undefined {
  return entries.length > 0 ? JSON.stringify(entries) : undefined;
}

function decodeHistoryMessage(message: string | undefined): HistoryEntry[] {
  if (!message) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    // A commit message this backend did not write — a Loro document is allowed
    // to have other authors — is not a defect, it just carries no history.
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (entry): entry is HistoryEntry =>
      entry !== null &&
      typeof entry === "object" &&
      typeof (entry as HistoryEntry).opId === "string" &&
      typeof (entry as HistoryEntry).op === "string" &&
      typeof (entry as HistoryEntry).id === "string",
  );
}

export function historyOf(doc: LoroDoc, filter?: HistoryFilter): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const changes of doc.getAllChanges().values()) {
    for (const change of changes) {
      entries.push(...decodeHistoryMessage(change.message));
    }
  }
  return selectHistory(entries, filter);
}
