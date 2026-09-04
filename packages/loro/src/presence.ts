import {
  sortPeers,
  type Peer,
  type Presence,
  type PresenceEvent,
  type PresenceListener,
} from "@collabnode/collab";

/**
 * Peers of one in-process document.
 *
 * Loro's own `EphemeralStore` is a timestamp-LWW key-value store, not a peer
 * roster: it can carry what a peer is doing but not reliably say when one
 * arrived or left, which is exactly what the hub's idle reaping asks. Since
 * this backend is in-process, the process itself is the authority on who is
 * connected, and this is that. A networked Loro server would replace it with a
 * roster derived from live connections.
 */
export interface LoroRoom {
  peers: Map<string, Peer>;
  listeners: Map<PresenceEvent, Set<PresenceListener>>;
}

export function emptyRoom(): LoroRoom {
  return { peers: new Map(), listeners: new Map() };
}

function roomPeers(room: LoroRoom): Peer[] {
  return sortPeers([...room.peers.values()]);
}

export function emitPresence(room: LoroRoom, event: PresenceEvent, peer: Peer): void {
  const peers = roomPeers(room);
  for (const listener of room.listeners.get(event) ?? []) {
    listener(peer, peers);
  }
}

export class LoroPresence implements Presence {
  constructor(
    private readonly room: LoroRoom,
    private readonly connectionId: string,
  ) {}

  peers(): Peer[] {
    const self = this.room.peers.get(this.connectionId);
    return roomPeers(this.room).map((peer) => ({
      ...peer,
      state: { ...peer.state },
      self: peer === self,
    }));
  }

  set(state: Record<string, unknown>): void {
    const peer = this.room.peers.get(this.connectionId);
    if (!peer) {
      return;
    }
    const next: Peer = { ...peer, state: { ...peer.state, ...state } };
    this.room.peers.set(this.connectionId, next);
    emitPresence(this.room, "change", next);
  }

  on(event: PresenceEvent, listener: PresenceListener): () => void {
    let set = this.room.listeners.get(event);
    if (!set) {
      set = new Set();
      this.room.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }
}
