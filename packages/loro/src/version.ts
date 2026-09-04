import { CollabError, type VersionToken } from "@collabnode/collab";
import { decodeFrontiers, encodeFrontiers, type LoroDoc, type OpId } from "loro-crdt";

export const LORO_KIND = "loro";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Frontiers, not a version vector, are what a token carries.
 *
 * Both name the same version, but frontiers stay a handful of OpIds however
 * many peers have touched the document, while a version vector grows one entry
 * per peer — and peers are minted per connection. An artifact that outlives a
 * thousand short-lived joins should not carry a thousand counters.
 */
export function tokenOf(doc: LoroDoc): VersionToken {
  return { kind: LORO_KIND, encoded: toBase64(encodeFrontiers(doc.frontiers())) };
}

export function frontiersOf(token: VersionToken): OpId[] {
  if (token.kind !== LORO_KIND) {
    throw new CollabError(
      `version token was minted by the '${token.kind}' backend and cannot be read by '${LORO_KIND}'`,
    );
  }
  try {
    return decodeFrontiers(fromBase64(token.encoded));
  } catch (error) {
    throw new CollabError(`malformed loro version token: ${String(error)}`);
  }
}

/**
 * Whether `frontiers` still names a version this document can diff from.
 *
 * A shallow snapshot drops the history before its cut point, so a token minted
 * before that cut is no longer answerable. Saying so is the whole reason
 * `diffSince` may return `undefined`: the caller falls back to a full snapshot
 * instead of projecting a diff computed from a version the document has
 * forgotten.
 */
export function isReachable(doc: LoroDoc, frontiers: OpId[]): boolean {
  if (frontiers.length === 0) {
    // The empty frontier is the document's beginning, which a shallow document
    // has thrown away and a full one always has.
    return !doc.isShallow();
  }
  try {
    // `frontiersToVV` throws for a version this document's history no longer
    // covers, which is exactly the question being asked.
    const version = doc.frontiersToVV(frontiers);
    const shallowSince = doc.shallowSinceVV();
    if (shallowSince.length() > 0) {
      const comparison = shallowSince.compare(version);
      // `undefined` means the two are concurrent, so the trim removed ops this
      // version depends on. A positive comparison means the trim is ahead of it.
      if (comparison === undefined || comparison > 0) {
        return false;
      }
    }
    // A version ahead of ours names ops that have not reached this peer yet.
    return doc.cmpWithFrontiers(frontiers) >= 0;
  } catch {
    return false;
  }
}
