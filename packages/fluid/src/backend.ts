import {
  assertSchemaMatch,
  unsupported,
  type CollabBackend,
  type CollabBackendCapabilities,
  type CollabHandle,
  type OpenOptions,
  CollabError,
} from "@collabnode/collab";
import { DEFAULT_HISTORY_LIMIT, type GraphSchema } from "@collabnode/schema";
import {
  ConnectionState,
  TreeViewConfiguration,
  type IFluidContainer,
  type ITree,
  type TreeView,
} from "fluid-framework";
import { FluidCollaborativeGraph } from "./graph.js";
import { CollabDocument } from "./collab-schema.js";
import {
  createTinyliciousClient,
  createTinyliciousContainer,
  loadTinyliciousContainer,
  type TinyliciousOptions,
} from "./tinylicious.js";
import { GraphDocument } from "./tree-schema.js";

const treeConfig = new TreeViewConfiguration({ schema: GraphDocument });
const collabConfig = new TreeViewConfiguration({ schema: CollabDocument });

function viewOf(container: IFluidContainer): TreeView<typeof GraphDocument> {
  const tree = container.initialObjects.graph as ITree | undefined;
  if (!tree || typeof tree.viewWith !== "function") {
    throw new CollabError("Fluid container is missing SharedTree initial object 'graph'");
  }
  return tree.viewWith(treeConfig);
}

function collabViewOf(container: IFluidContainer): TreeView<typeof CollabDocument> {
  const tree = container.initialObjects.collab as ITree | undefined;
  if (!tree || typeof tree.viewWith !== "function") {
    throw new CollabError("Fluid container is missing SharedTree initial object 'collab'");
  }
  return tree.viewWith(collabConfig);
}

function initializeCollabIfNeeded(view: TreeView<typeof CollabDocument>): void {
  if (view.compatibility.canInitialize) {
    view.initialize(new CollabDocument({ nodes: new Map() }));
  }
}

function initializeIfNeeded(view: TreeView<typeof GraphDocument>, schema: GraphSchema): void {
  if (view.compatibility.canInitialize) {
    view.initialize(
      new GraphDocument({
        schemaId: schema.config.schemaId,
        schemaHash: schema.schemaHash,
        nodes: new Map(),
        edges: new Map(),
        history: [],
        historyLimit: schema.config.changeTracking.historyLimit ?? DEFAULT_HISTORY_LIMIT,
      }),
    );
    return;
  }
  if (!view.compatibility.canView) {
    throw new CollabError(
      "Fluid SharedTree schema is not compatible with this client. All peers must use the same collabnode version.",
    );
  }
  assertSchemaMatch(schema, {
    schemaId: view.root.schemaId,
    schemaHash: view.root.schemaHash,
    nodes: [],
    edges: [],
  });
}

async function waitConnected(container: IFluidContainer): Promise<void> {
  if (container.connectionState === ConnectionState.Connected) {
    return;
  }
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    const emitter = container as IFluidContainer & {
      once?: (event: "connected", listener: () => void) => void;
      on?: (event: "connected", listener: () => void) => void;
    };
    if (typeof emitter.once === "function") {
      emitter.once("connected", done);
      return;
    }
    if (typeof emitter.on === "function") {
      emitter.on("connected", done);
      return;
    }
    resolve();
  });
}

/**
 * Waits for pending ops to reach the service before the container is disposed.
 *
 * `dispose()` drops whatever has not been acknowledged yet. Against Tinylicious
 * on localhost that window is invisible; against a hosted relay it is a network
 * round trip, which is long enough for a replica shutting down to lose the last
 * write it accepted.
 */
async function waitSaved(container: IFluidContainer, timeoutMs = 5_000): Promise<void> {
  const emitter = container as IFluidContainer & {
    isDirty?: boolean;
    once?: (event: "saved", listener: () => void) => void;
    off?: (event: "saved", listener: () => void) => void;
  };
  if (emitter.isDirty !== true || typeof emitter.once !== "function") {
    return;
  }
  await new Promise<void>((resolve) => {
    // A disconnected container never fires "saved". The timeout is what keeps
    // shutdown bounded instead of hanging on a relay that is not answering.
    const timer = setTimeout(finish, timeoutMs);
    function finish(): void {
      clearTimeout(timer);
      emitter.off?.("saved", finish);
      resolve();
    }
    emitter.once?.("saved", finish);
  });
}

async function waitUntilViewable(view: {
  compatibility: { canView: boolean; canInitialize: boolean };
}): Promise<void> {
  const start = Date.now();
  while (!view.compatibility.canView && !view.compatibility.canInitialize && Date.now() - start < 10_000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export interface FluidCollabBackendOptions extends TinyliciousOptions {
  /**
   * Injected container factory — used by the Azure adapter so Fluid's CRDT
   * stays shared while the relay is swapped.
   */
  open?: {
    create: () => Promise<{ container: IFluidContainer; id: string }>;
    load: (id: string) => Promise<IFluidContainer>;
  };
}

export class FluidCollabBackend implements CollabBackend {
  readonly kind = "fluid";
  /**
   * Fluid mints container ids at attach time and the relay owns the document's
   * lifetime, so two of the three ephemeral capabilities are simply not this
   * backend's to offer. Measured cold start (~179 ms mean, 371 ms worst) points
   * the same way: Fluid is the durable-document backend, and declaring that
   * here is what stops a caller discovering it at termination time.
   */
  readonly capabilities: CollabBackendCapabilities = {
    namedDocuments: false,
    deletion: false,
    presence: false,
  };
  private readonly container: NonNullable<FluidCollabBackendOptions["open"]>;

  constructor(options: FluidCollabBackendOptions = {}) {
    if (options.open) {
      this.container = options.open;
    } else {
      const client = createTinyliciousClient(options);
      this.container = {
        create: () => createTinyliciousContainer(client),
        load: (id) => loadTinyliciousContainer(client, id),
      };
    }
  }

  async open(
    id: string | undefined,
    schema: GraphSchema,
    _options: OpenOptions = {},
  ): Promise<CollabHandle> {
    return id === undefined ? this.createNew(schema) : this.load(id, schema);
  }

  async delete(_id: string): Promise<void> {
    throw unsupported(this.kind, "deletion");
  }

  async exists(id: string): Promise<boolean> {
    try {
      const container = await this.container.load(id);
      container.dispose();
      return true;
    } catch {
      return false;
    }
  }

  private async createNew(schema: GraphSchema): Promise<CollabHandle> {
    const { container, id } = await this.container.create();
    const view = viewOf(container);
    const collabView = collabViewOf(container);
    initializeIfNeeded(view, schema);
    initializeCollabIfNeeded(collabView);
    await waitConnected(container);
    return this.handle(id, container, view, collabView, schema);
  }

  private async load(id: string, schema: GraphSchema): Promise<CollabHandle> {
    const container = await this.container.load(id);
    await waitConnected(container);
    const view = viewOf(container);
    const collabView = collabViewOf(container);
    await waitUntilViewable(view);
    await waitUntilViewable(collabView);
    initializeIfNeeded(view, schema);
    initializeCollabIfNeeded(collabView);
    assertSchemaMatch(schema, {
      schemaId: view.root.schemaId,
      schemaHash: view.root.schemaHash,
      nodes: [],
      edges: [],
    });
    return this.handle(id, container, view, collabView, schema);
  }

  private handle(
    id: string,
    container: IFluidContainer,
    view: TreeView<typeof GraphDocument>,
    collabView: TreeView<typeof CollabDocument>,
    schema: GraphSchema,
  ): CollabHandle {
    return {
      id,
      graph: new FluidCollaborativeGraph(view, collabView, container, schema),
      presence: () => {
        throw unsupported(this.kind, "presence");
      },
      close: async () => {
        await waitSaved(container);
        container.dispose();
      },
    };
  }
}
