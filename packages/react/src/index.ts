import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { connect, type ConnectOptions, type WebCollab } from "@collabnode/web";
import { resolveView } from "@collabnode/runtime";
import type {
  ApplyOpsResult,
  BatchBuilder,
  CollabSession,
  GraphOpInput,
  MutationOptions,
  ResolvedView,
  UpsertEdgeInput,
  UpsertNodeInput,
} from "@collabnode/runtime";
import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from "@collabnode/graph";
import type { Peer } from "@collabnode/collab";
import type {
  AnyGraph,
  EdgeNameOf,
  GraphTypeMap,
  NodeNameOf,
  ViewDef,
} from "@collabnode/schema";

/**
 * Every hook here takes a workspace's type map as its first type argument, and
 * defaults to `AnyGraph` — the untyped shapes these hooks have always had. Pass
 * the `GraphTypes<…>` a generated module exports and the snapshot, the writes
 * and `nodesByType` all narrow to that schema.
 */
export interface UseCollabResult<S extends GraphTypeMap = AnyGraph> {
  session: CollabSession<S> | null;
  snapshot: GraphSnapshot<S> | null;
  isLoading: boolean;
  isConnected: boolean;
  error: Error | null;
  /** Nodes grouped by `type`, so a view does not filter the snapshot itself. */
  nodesByType: { [T in NodeNameOf<S>]?: GraphNodeRecord<S, T>[] };
  upsertNode: (input: UpsertNodeInput<S>, options?: MutationOptions) => Promise<string>;
  deleteNode: (id: string, options?: MutationOptions) => Promise<void>;
  upsertEdge: (input: UpsertEdgeInput<S>, options?: MutationOptions) => Promise<string>;
  deleteEdge: (id: string, options?: MutationOptions) => Promise<void>;
}

const EMPTY_SNAPSHOT: GraphSnapshot = { schemaId: "", schemaHash: "", nodes: [], edges: [] };

interface SessionStore {
  snapshot: GraphSnapshot;
  listeners: Set<() => void>;
  subscribe(listener: () => void): () => void;
}

const sessionStores = new WeakMap<CollabSession, SessionStore>();

/**
 * One cached snapshot per session, shared by every hook reading it.
 *
 * The session subscription is held only while something is listening. A store
 * that stayed subscribed for the lifetime of the session would keep feeding a
 * snapshot nobody reads — and would keep the closure, and everything it
 * captures, alive after the last component unmounted.
 */
function getSessionStore(session: CollabSession): SessionStore {
  const cached = sessionStores.get(session);
  if (cached) {
    return cached;
  }
  const listeners = new Set<() => void>();
  let stop: (() => void) | undefined;
  const store: SessionStore = {
    snapshot: session.snapshot(),
    listeners,
    subscribe(listener) {
      if (listeners.size === 0) {
        // Nothing was listening, so the cached snapshot may be behind. Catch it
        // up before the first read, and again on every change after that.
        store.snapshot = session.snapshot();
        stop = session.onChange((_ops, nextSnapshot) => {
          store.snapshot = nextSnapshot;
          for (const entry of Array.from(listeners)) {
            entry();
          }
        });
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stop?.();
          stop = undefined;
        }
      };
    },
  };
  sessionStores.set(session, store);
  return store;
}

/**
 * React hook to connect to a collabnode document in the browser.
 *
 * The connection is owned by the hook: unmounting, or pointing it at a
 * different document, closes the one it opened. A `connect()` whose result is
 * dropped keeps its container, its socket and its presence registration for as
 * long as the tab lives, and StrictMode opens two of them per mount.
 */
export function useCollab<S extends GraphTypeMap = AnyGraph>(
  options?: ConnectOptions | null,
): UseCollabResult<S> {
  const [session, setSession] = useState<CollabSession<S> | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(Boolean(options));
  const [error, setError] = useState<Error | null>(null);

  // Read inside the effect without being part of what re-runs it: the identity
  // of `options` changes on every render of most callers, while the keys below
  // are what actually decide whether this is a different connection.
  const latestOptions = useRef(options);
  latestOptions.current = options;

  const documentId = options?.documentId;
  const actorId = options?.actorId;
  const collabKey = collabIdentity(options?.collab);
  const schemaKey =
    typeof options?.schema === "string"
      ? options.schema
      : options?.schema?.config?.schemaId || options?.schema?.name;

  useEffect(() => {
    const current = latestOptions.current;
    if (!current || !documentId) {
      setSession(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let active = true;
    let opened: WebCollab | undefined;
    setIsLoading(true);
    setError(null);

    connect(current)
      .then((collab: WebCollab) => {
        opened = collab;
        if (!active) {
          // Torn down while the connection was in flight. Nothing will ever
          // read this session, so close it here rather than leaking it.
          void collab.close();
          return;
        }
        setSession(collab.session as unknown as CollabSession<S>);
        setIsLoading(false);
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
      setSession(null);
      void opened?.close();
    };
  }, [documentId, actorId, schemaKey, collabKey]);

  const snapshot = useCollabSnapshot(session);
  const nodesByType = useMemo(
    () => groupByType(snapshot.nodes) as UseCollabResult<S>["nodesByType"],
    [snapshot],
  );

  const upsertNode = useCallback(
    async (input: UpsertNodeInput<S>, mutationOpts?: MutationOptions) => {
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
    async (input: UpsertEdgeInput<S>, mutationOpts?: MutationOptions) => {
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
    nodesByType,
    upsertNode,
    deleteNode,
    upsertEdge,
    deleteEdge,
  };
}

/**
 * Subscribe to realtime graph changes on a CollabSession using useSyncExternalStore with cached snapshots.
 */
export function useCollabSnapshot<S extends GraphTypeMap = AnyGraph>(
  session: CollabSession<S> | null | undefined,
): GraphSnapshot<S> {
  const store = session ? getSessionStore(session as unknown as CollabSession) : null;

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!store) return () => {};
      return store.subscribe(onStoreChange);
    },
    [store],
  );

  const getSnapshot = useCallback(() => {
    if (!store) return EMPTY_SNAPSHOT;
    return store.snapshot;
  }, [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot) as unknown as GraphSnapshot<S>;
}

/**
 * Select nodes from the active graph session, optionally filtered by type.
 */
export function useCollabNodes<
  S extends GraphTypeMap = AnyGraph,
  T extends NodeNameOf<S> = NodeNameOf<S>,
>(session: CollabSession<S> | null | undefined, type?: T): GraphNodeRecord<S, T>[] {
  const snapshot = useCollabSnapshot(session);
  return useMemo(() => {
    if (!type) return snapshot.nodes as GraphNodeRecord<S, T>[];
    return snapshot.nodes.filter((node) => node.type === type) as GraphNodeRecord<S, T>[];
  }, [snapshot, type]);
}

/**
 * Select a single node from the active graph session by its ID.
 */
export function useCollabNode<S extends GraphTypeMap = AnyGraph>(
  session: CollabSession<S> | null | undefined,
  id: string | null | undefined,
): GraphNodeRecord<S> | undefined {
  const snapshot = useCollabSnapshot(session);
  return useMemo(() => {
    if (!id) return undefined;
    return snapshot.nodes.find((node) => node.id === id);
  }, [snapshot, id]);
}

/**
 * Resolve one named view against the live graph.
 *
 * This is the browser half of the `views:` DSL block: the same declaration that
 * generates an agent's `view_<name>` tool decides what a panel shows, so the two
 * cannot drift. `view` is the definition itself — take it from
 * `useCollabJoin().join?.views` — and `params` are the view's own parameters.
 *
 * Recomputes when the snapshot changes, like the other selectors here. Pass a
 * stable `params` object (or memoize it) to avoid re-resolving every render.
 */
export function useCollabView(
  session: CollabSession | null | undefined,
  view: ViewDef | null | undefined,
  params?: Record<string, unknown>,
  options?: { name?: string; language?: string },
): ResolvedView | null {
  const snapshot = useCollabSnapshot(session);
  const schema = session?.schema;
  const name = options?.name;
  const language = options?.language;
  // Params are compared by value: a caller writing `{ epic }` inline should not
  // force a fresh resolve on every render just for having built a new object.
  const paramsKey = JSON.stringify(params ?? {});
  return useMemo(() => {
    if (!view) {
      return null;
    }
    try {
      return resolveView(snapshot, view, JSON.parse(paramsKey), { name, language, schema });
    } catch {
      // A view whose required parameter is missing is a normal intermediate
      // state in a UI — the user has not picked an epic yet — not an error the
      // whole panel should crash on.
      return null;
    }
  }, [snapshot, view, paramsKey, name, language, schema]);
}

/**
 * Select edges from the active graph session, optionally filtered by type.
 */
export function useCollabEdges<
  S extends GraphTypeMap = AnyGraph,
  T extends EdgeNameOf<S> = EdgeNameOf<S>,
>(session: CollabSession<S> | null | undefined, type?: T): GraphEdgeRecord<S, T>[] {
  const snapshot = useCollabSnapshot(session);
  return useMemo(() => {
    if (!type) return snapshot.edges as GraphEdgeRecord<S, T>[];
    return snapshot.edges.filter((edge) => edge.type === type) as GraphEdgeRecord<S, T>[];
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

export interface CollabContextValue<S extends GraphTypeMap = AnyGraph>
  extends UseCollabResult<S> {}

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
export function useCollabBatch<S extends GraphTypeMap = AnyGraph>(
  session: CollabSession<S> | null | undefined,
) {
  const batch = useCallback(
    async (
      fn: (b: BatchBuilder<S>) => void | Promise<void>,
      options?: MutationOptions,
    ): Promise<ApplyOpsResult> => {
      if (!session) throw new Error("No active collab session");
      return session.batch(fn, options);
    },
    [session],
  );

  const applyOps = useCallback(
    async (ops: GraphOpInput<S>[], options?: MutationOptions): Promise<ApplyOpsResult> => {
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
export function useCollabNodeState<V = unknown, S extends GraphTypeMap = AnyGraph>(
  session: CollabSession<S> | null | undefined,
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
        // Only the property being set. An upsert merges into what is stored, so
        // resending the rest of the bag from a snapshot adds nothing — and puts
        // this replica's view of every other field back on the wire.
        await session.upsertNode(
          { id: nodeId, type: node.type, properties: { [propertyKey]: newValue } } as
            UpsertNodeInput<S>,
          options,
        );
      } finally {
        setIsSaving(false);
      }
    },
    [session, nodeId, node, propertyKey, options],
  );

  return [value, setValue, isSaving];
}

/**
 * What a `ConnectOptions.collab` descriptor is, as a string, for deciding
 * whether an effect is looking at the same connection as before.
 *
 * `JSON.stringify` on the whole descriptor throws on a `{ kind: "custom" }`
 * backend holding a cycle, and a token provider is a function that stringifies
 * away — so only the fields that name the relay are read.
 */
function collabIdentity(collab: ConnectOptions["collab"] | undefined): string | undefined {
  if (!collab) {
    return undefined;
  }
  const named = collab as { kind: string; relay?: string; url?: string; endpoint?: string; tenantId?: string; tokenEndpoint?: string };
  return [named.kind, named.relay, named.url, named.endpoint, named.tenantId, named.tokenEndpoint]
    .map((part) => part ?? "")
    .join("|");
}

/**
 * Buckets nodes by `type`.
 *
 * Deliberately structural rather than typed against a schema: the callers that
 * need the narrow result cast once, and asking this to be generic would mean
 * correlating each bucket's key with its element type, which TypeScript cannot
 * do while the key is still a variable.
 */
function groupByType(
  nodes: readonly { type: string }[],
): Record<string, { type: string }[]> {
  const grouped: Record<string, { type: string }[]> = {};
  for (const node of nodes) {
    const bucket = grouped[node.type] ?? [];
    bucket.push(node);
    grouped[node.type] = bucket;
  }
  return grouped;
}

export interface UseCollabJoinResult<S extends GraphTypeMap = AnyGraph>
  extends UseCollabResult<S> {
  /** What the join endpoint answered, once it has answered. */
  join: JoinResponse | null;
}

/** The join payload a collabnode server hands a browser. */
export interface JoinResponse {
  documentId: string;
  schema: ConnectOptions["schema"];
  collab: ConnectOptions["collab"];
  /**
   * The workspace type's named graph slices, so the browser renders the same
   * views the agents reason about instead of re-deriving its own selections.
   */
  views?: Record<string, ViewDef>;
  [key: string]: unknown;
}

export interface UseCollabJoinOptions {
  /** Identity for writes from this browser. */
  actorId?: string;
  graph?: ConnectOptions["graph"];
  /** Passed through to `fetch`, e.g. for credentials or an auth header. */
  fetchOptions?: RequestInit;
}

/**
 * Fetch a join descriptor from the server, then connect to what it describes.
 *
 * Every browser app needs this pair: the server owns the document id, the
 * schema and the relay coordinates, and the browser cannot invent any of them.
 * `url` is your join route — the one that answers
 * `{ documentId, schema, collab }`.
 */
export function useCollabJoin<S extends GraphTypeMap = AnyGraph>(
  url: string | null | undefined,
  options: UseCollabJoinOptions = {},
): UseCollabJoinResult<S> {
  const [join, setJoin] = useState<JoinResponse | null>(null);
  const [joinError, setJoinError] = useState<Error | null>(null);
  const { actorId, graph } = options;

  // Read at fetch time, not depended on: a caller passing `{ credentials }`
  // inline would otherwise hand this effect a new object every render, and the
  // effect would re-fetch forever.
  const fetchOptions = useRef(options.fetchOptions);
  fetchOptions.current = options.fetchOptions;

  useEffect(() => {
    if (!url) {
      setJoin(null);
      return;
    }
    const controller = new AbortController();
    setJoinError(null);
    fetch(url, { ...fetchOptions.current, signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`join request failed: ${response.status}`);
        }
        return (await response.json()) as JoinResponse;
      })
      .then(setJoin)
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setJoin(null);
        setJoinError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => controller.abort();
  }, [url]);

  const connectOptions = useMemo<ConnectOptions | null>(() => {
    if (!join) {
      return null;
    }
    return {
      schema: join.schema,
      documentId: join.documentId,
      collab: join.collab,
      ...(actorId !== undefined ? { actorId } : {}),
      ...(graph !== undefined ? { graph } : {}),
    };
  }, [join, actorId, graph]);

  const collab = useCollab<S>(connectOptions);
  return {
    ...collab,
    join,
    isLoading: collab.isLoading || (Boolean(url) && !join && !joinError),
    error: joinError ?? collab.error,
  };
}
