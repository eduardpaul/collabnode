import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { connect, type ConnectOptions, type WebCollab } from "@collabnode/web";
import type {
  ApplyOpsResult,
  BatchBuilder,
  CollabSession,
  GraphOpInput,
  MutationOptions,
  UpsertEdgeInput,
  UpsertNodeInput,
} from "@collabnode/runtime";
import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from "@collabnode/graph";
import type { Peer } from "@collabnode/collab";

export interface UseCollabResult {
  session: CollabSession | null;
  snapshot: GraphSnapshot | null;
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  upsertNode: (input: UpsertNodeInput, options?: MutationOptions) => Promise<string>;
  deleteNode: (id: string, options?: MutationOptions) => Promise<void>;
  upsertEdge: (input: UpsertEdgeInput, options?: MutationOptions) => Promise<string>;
  deleteEdge: (id: string, options?: MutationOptions) => Promise<void>;
}

const EMPTY_SNAPSHOT: GraphSnapshot = { schemaId: "", schemaHash: "", nodes: [], edges: [] };

interface SessionStore {
  snapshot: GraphSnapshot;
  listeners: Set<() => void>;
}

const sessionStores = new WeakMap<CollabSession, SessionStore>();

function getSessionStore(session: CollabSession): SessionStore {
  let store = sessionStores.get(session);
  if (!store) {
    const listeners = new Set<() => void>();
    store = {
      snapshot: session.snapshot(),
      listeners,
    };
    session.onChange((_ops, nextSnapshot) => {
      store!.snapshot = nextSnapshot;
      for (const listener of Array.from(listeners)) {
        listener();
      }
    });
    sessionStores.set(session, store);
  }
  return store;
}

/**
 * React hook to connect to a collabnode document in the browser.
 */
export function useCollab(options?: ConnectOptions | null): UseCollabResult {
  const [session, setSession] = useState<CollabSession | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(options));
  const [error, setError] = useState<Error | null>(null);

  const documentId = options?.documentId;
  const actorId = options?.actorId;
  const collabKey = options?.collab ? JSON.stringify(options.collab) : undefined;
  const schemaKey =
    typeof options?.schema === "string"
      ? options.schema
      : options?.schema?.config?.schemaId || options?.schema?.name;

  useEffect(() => {
    if (!options || !documentId) {
      setSession(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setIsLoading(true);
    setError(null);

    connect(options)
      .then((collab: WebCollab) => {
        if (active) {
          setSession(collab.session);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          setError(errObj);
          setIsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [documentId, actorId, schemaKey, collabKey]);

  const snapshot = useCollabSnapshot(session);

  const upsertNode = useCallback(
    async (input: UpsertNodeInput, mutationOpts?: MutationOptions) => {
      if (!session) throw new Error("No active collab session");
      return session.upsertNode(input, mutationOpts);
    },
    [session],
  );

  const deleteNode = useCallback(
    async (id: string, mutationOpts?: MutationOptions) => {
      if (!session) throw new Error("No active collab session");
      return session.deleteNode(id, mutationOpts);
    },
    [session],
  );

  const upsertEdge = useCallback(
    async (input: UpsertEdgeInput, mutationOpts?: MutationOptions) => {
      if (!session) throw new Error("No active collab session");
      return session.upsertEdge(input, mutationOpts);
    },
    [session],
  );

  const deleteEdge = useCallback(
    async (id: string, mutationOpts?: MutationOptions) => {
      if (!session) throw new Error("No active collab session");
      return session.deleteEdge(id, mutationOpts);
    },
    [session],
  );

  return {
    session,
    snapshot,
    isLoading,
    isConnected: Boolean(session),
    error,
    upsertNode,
    deleteNode,
    upsertEdge,
    deleteEdge,
  };
}

/**
 * Subscribe to realtime graph changes on a CollabSession using useSyncExternalStore with cached snapshots.
 */
export function useCollabSnapshot(session: CollabSession | null | undefined): GraphSnapshot {
  const store = session ? getSessionStore(session) : null;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!store) return () => {};
      store.listeners.add(onStoreChange);
      return () => {
        store.listeners.delete(onStoreChange);
      };
    },
    [store],
  );

  const getSnapshot = useCallback(() => {
    if (!store) return EMPTY_SNAPSHOT;
    return store.snapshot;
  }, [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Select nodes from the active graph session, optionally filtered by type.
 */
export function useCollabNodes<T extends GraphNodeRecord = GraphNodeRecord>(
  session: CollabSession | null | undefined,
  type?: string,
): T[] {
  const snapshot = useCollabSnapshot(session);
  return useMemo(() => {
    if (!type) return snapshot.nodes as T[];
    return snapshot.nodes.filter((node) => node.type === type) as T[];
  }, [snapshot, type]);
}

/**
 * Select a single node from the active graph session by its ID.
 */
export function useCollabNode<T extends GraphNodeRecord = GraphNodeRecord>(
  session: CollabSession | null | undefined,
  id: string | null | undefined,
): T | undefined {
  const snapshot = useCollabSnapshot(session);
  return useMemo(() => {
    if (!id) return undefined;
    return snapshot.nodes.find((node) => node.id === id) as T | undefined;
  }, [snapshot, id]);
}

/**
 * Select edges from the active graph session, optionally filtered by type.
 */
export function useCollabEdges(
  session: CollabSession | null | undefined,
  type?: string,
): GraphEdgeRecord[] {
  const snapshot = useCollabSnapshot(session);
  return useMemo(() => {
    if (!type) return snapshot.edges;
    return snapshot.edges.filter((edge) => edge.type === type);
  }, [snapshot, type]);
}

/**
 * Track connected peers presence.
 */
export function useCollabPresence(session: CollabSession | null | undefined): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    if (!session) {
      setPeers([]);
      return;
    }

    try {
      const presence = session.presence();
      const update = () => setPeers(presence.peers());
      update();
      const unsubJoin = presence.on("join", update);
      const unsubLeave = presence.on("leave", update);
      const unsubChange = presence.on("change", update);
      return () => {
        unsubJoin();
        unsubLeave();
        unsubChange();
      };
    } catch {
      setPeers([]);
    }
  }, [session]);

  return peers;
}

export interface CollabContextValue extends UseCollabResult {}

const CollabContext = createContext<CollabContextValue | null>(null);

export interface CollabProviderProps {
  options?: ConnectOptions | null;
  children: ReactNode;
}

export function CollabProvider({ options, children }: CollabProviderProps) {
  const collab = useCollab(options);
  return createElement(CollabContext.Provider, { value: collab }, children);
}

export function useCollabContext(): CollabContextValue {
  const context = useContext(CollabContext);
  if (!context) {
    throw new Error("useCollabContext must be used within a CollabProvider");
  }
  return context;
}

/**
 * Hook to execute batch mutations on a CollabSession.
 */
export function useCollabBatch(session: CollabSession | null | undefined) {
  const batch = useCallback(
    async (
      fn: (b: BatchBuilder) => void | Promise<void>,
      options?: MutationOptions,
    ): Promise<ApplyOpsResult> => {
      if (!session) throw new Error("No active collab session");
      return session.batch(fn, options);
    },
    [session],
  );

  const applyOps = useCallback(
    async (ops: GraphOpInput[], options?: MutationOptions): Promise<ApplyOpsResult> => {
      if (!session) throw new Error("No active collab session");
      return session.applyOps(ops, options);
    },
    [session],
  );

  return { batch, applyOps };
}

/**
 * Reactive hook to get and set an individual property on a node live over CRDT.
 */
export function useCollabNodeState<V = unknown>(
  session: CollabSession | null | undefined,
  nodeId: string | null | undefined,
  propertyKey: string,
  options?: MutationOptions,
): [V | undefined, (value: V) => Promise<void>, boolean] {
  const node = useCollabNode(session, nodeId);
  const [isSaving, setIsSaving] = useState(false);

  const value = node?.properties ? (node.properties[propertyKey] as V) : undefined;

  const setValue = useCallback(
    async (newValue: V) => {
      if (!session || !nodeId || !node) return;
      setIsSaving(true);
      try {
        await session.upsertNode(
          {
            id: nodeId,
            type: node.type,
            properties: {
              ...node.properties,
              [propertyKey]: newValue,
            },
          },
          options,
        );
      } finally {
        setIsSaving(false);
      }
    },
    [session, nodeId, node, propertyKey, options?.actorId],
  );

  return [value, setValue, isSaving];
}
