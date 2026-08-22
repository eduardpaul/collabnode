/**
 * Who is in a document right now.
 *
 * Both CRDT vendors already carry this — Yjs as `y-protocols/awareness`, Fluid
 * as the container audience — and neither was exposed. It is promoted to the
 * backend contract because idle-based termination cannot be built without it:
 * "no writes for 30 minutes" is not the same question as "nobody is here", and
 * only the second one is safe to reap on.
 */
export type PeerKind = "human" | "agent";

export interface Peer {
  /** The writer identity this peer mutates as; matches change attribution. */
  actorId: string;
  kind: PeerKind;
  /** ISO timestamp of when this peer was first seen by this client. */
  since: string;
  /** Free-form per-peer state: cursor, selection, typing. */
  state: Record<string, unknown>;
  /** True for the peer this handle belongs to. */
  self: boolean;
}

export type PresenceEvent = "join" | "leave" | "change";

export type PresenceListener = (peer: Peer, peers: Peer[]) => void;

export interface Presence {
  /** Everyone currently connected, including self, ordered by `since` then actorId. */
  peers(): Peer[];
  /** Merge fields into this peer's published state. */
  set(state: Record<string, unknown>): void;
  on(event: PresenceEvent, listener: PresenceListener): () => void;
}

export interface PresenceIdentity {
  actorId: string;
  kind?: PeerKind;
}

export function sortPeers(peers: Peer[]): Peer[] {
  return [...peers].sort((a, b) => a.since.localeCompare(b.since) || a.actorId.localeCompare(b.actorId));
}

/**
 * Presence for backends that have no peer channel. It reports the local peer
 * truthfully and never invents remote ones — a backend whose
 * `capabilities.presence` is false is saying "peers() is not the whole room",
 * and the honest answer to "who else is here" is one this cannot give.
 */
export class LocalOnlyPresence implements Presence {
  private readonly listeners = new Map<PresenceEvent, Set<PresenceListener>>();
  private readonly since = new Date().toISOString();
  private state: Record<string, unknown> = {};

  constructor(private readonly identity: PresenceIdentity) {}

  peers(): Peer[] {
    return [this.selfPeer()];
  }

  set(state: Record<string, unknown>): void {
    this.state = { ...this.state, ...state };
    this.emit("change", this.selfPeer());
  }

  on(event: PresenceEvent, listener: PresenceListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  protected emit(event: PresenceEvent, peer: Peer): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(peer, this.peers());
    }
  }

  private selfPeer(): Peer {
    return {
      actorId: this.identity.actorId,
      kind: this.identity.kind ?? "human",
      since: this.since,
      state: { ...this.state },
      self: true,
    };
  }
}
