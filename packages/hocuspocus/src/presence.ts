import { unsupported, sortPeers, type Peer, type PeerKind, type Presence, type PresenceEvent, type PresenceListener } from "@collabnode/collab";
import type { HocuspocusProvider } from "@hocuspocus/provider";

/** The awareness field collabnode publishes under; everything else is the app's. */
const FIELD = "collabnode";

interface PublishedPeer {
  actorId: string;
  kind: PeerKind;
  since: string;
  state: Record<string, unknown>;
}

function readPeer(value: unknown, clientId: number, self: boolean): Peer | undefined {
  const published = (value as { [FIELD]?: PublishedPeer } | undefined)?.[FIELD];
  if (!published || typeof published.actorId !== "string") {
    // A peer that has not published a collabnode identity — another app sharing
    // the document, or a client mid-handshake. Counting it would make presence
    // a connection count, which is not what callers ask it for.
    return undefined;
  }
  return {
    actorId: published.actorId,
    kind: published.kind === "agent" ? "agent" : "human",
    since: typeof published.since === "string" ? published.since : new Date(0).toISOString(),
    state: { ...(published.state ?? {}) },
    self,
  };
}

/**
 * Presence over `y-protocols/awareness`, which Hocuspocus already carries on
 * every connection. Awareness is ephemeral by construction — it lives in the
 * connection, not the document — so a peer that disconnects disappears without
 * anything having to reap it.
 */
export class HocuspocusPresence implements Presence {
  private readonly since = new Date().toISOString();
  private known = new Map<number, Peer>();
  private published: Record<string, unknown> = {};

  constructor(
    private readonly provider: HocuspocusProvider,
    private readonly identity: { actorId: string; kind: PeerKind },
  ) {
    this.publish();
    this.known = new Map(this.readAll());
  }

  peers(): Peer[] {
    return sortPeers([...this.readAll().values()]);
  }

  set(state: Record<string, unknown>): void {
    this.published = { ...this.published, ...state };
    this.publish();
  }

  on(event: PresenceEvent, listener: PresenceListener): () => void {
    const awareness = this.provider.awareness;
    if (!awareness) {
      throw unsupported("hocuspocus", "presence");
    }
    const handler = (): void => {
      const next = this.readAll();
      const peers = sortPeers([...next.values()]);
      if (event === "join") {
        for (const [clientId, peer] of next) {
          if (!this.known.has(clientId)) {
            listener(peer, peers);
          }
        }
      } else if (event === "leave") {
        for (const [clientId, peer] of this.known) {
          if (!next.has(clientId)) {
            listener(peer, peers);
          }
        }
      } else {
        for (const [clientId, peer] of next) {
          const before = this.known.get(clientId);
          if (before && JSON.stringify(before.state) !== JSON.stringify(peer.state)) {
            listener(peer, peers);
          }
        }
      }
      this.known = next;
    };
    awareness.on("change", handler);
    return () => {
      awareness.off("change", handler);
    };
  }

  private publish(): void {
    const payload: PublishedPeer = {
      actorId: this.identity.actorId,
      kind: this.identity.kind,
      since: this.since,
      state: this.published,
    };
    this.provider.setAwarenessField(FIELD, payload);
  }

  private readAll(): Map<number, Peer> {
    const awareness = this.provider.awareness;
    if (!awareness) {
      throw unsupported("hocuspocus", "presence");
    }
    const result = new Map<number, Peer>();
    for (const [clientId, state] of awareness.getStates()) {
      const peer = readPeer(state, clientId, clientId === awareness.clientID);
      if (peer) {
        result.set(clientId, peer);
      }
    }
    return result;
  }
}
