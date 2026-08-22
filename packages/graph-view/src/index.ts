import type { GraphSnapshot } from "@collabnode/graph";
import type { CollabSession } from "@collabnode/runtime";
import { resolveI18nString } from "@collabnode/schema";
import { DataSet, Network, type VisClickParams, type VisDataset, type VisNetwork } from "./view/vis.js";
import {
  changedEntityIds,
  emptyFilters,
  newNodeIds,
  nodeTypeHidden,
  parseVisibleTypes,
  patchFilters,
  planApply,
  projectGraph,
  toggleNodeType,
  withPulse,
  type ViewEdge,
  type ViewFilters,
  type ViewNode,
} from "./view/apply.js";
import { fieldsFor, propertiesFromForm, tagsFromForm } from "./view/form.js";
import { resolveLink } from "./view/edges.js";
import { attrEnabled, escapeHtml } from "@collabnode/web";
import { renderInspector, readFormValues, type GraphMode } from "./view/inspector.js";
import { typeColor } from "./view/style.js";
import { GRAPH_TEMPLATE } from "./view/template.js";

type NodeSet = VisDataset<ViewNode>;
type EdgeSet = VisDataset<ViewEdge>;

const NETWORK_OPTIONS = {
  autoResize: true,
  interaction: {
    hover: true,
    tooltipDelay: 240,
    navigationButtons: false,
    keyboard: false,
    dragNodes: true,
    dragView: true,
    zoomView: true,
    selectable: true,
  },
  physics: {
    enabled: true,
    solver: "forceAtlas2Based",
    forceAtlas2Based: {
      gravitationalConstant: -46,
      springLength: 120,
      springConstant: 0.08,
      damping: 0.62,
      avoidOverlap: 0.55,
    },
    stabilization: { enabled: true, iterations: 140, fit: true },
  },
  nodes: {
    borderWidth: 1,
    borderWidthSelected: 3,
    chosen: true,
    margin: 10,
    shadow: { enabled: true, color: "rgba(0,0,0,0.4)", size: 8 },
  },
  edges: {
    smooth: { type: "cubicBezier", roundness: 0.35 },
    selectionWidth: 2,
    hoverWidth: 1.5,
  },
};

export class CollabGraph extends HTMLElement {
  static readonly tagName = "collab-graph";
  static readonly observedAttributes = ["editable", "inspector", "toolbar", "visible-types"];

  #session: CollabSession | undefined;
  #stop: (() => void) | undefined;
  #network: VisNetwork | undefined;
  #nodes: NodeSet | undefined;
  #edges: EdgeSet | undefined;
  #nodeIds = new Set<string>();
  #edgeIds = new Set<string>();
  #previous: GraphSnapshot | undefined;
  #projected = new Map<string, ViewNode>();
  #filters: ViewFilters = emptyFilters();
  #mode: GraphMode = { kind: "idle" };
  #seeded = false;
  #searchTimer: number | undefined;
  #highlightTimer: number | undefined;
  #physicsTimer: number | undefined;
  #toastTimer: number | undefined;

  get filters(): ViewFilters {
    return {
      hiddenNodeTypes: new Set(this.#filters.hiddenNodeTypes),
      hiddenEdgeTypes: new Set(this.#filters.hiddenEdgeTypes),
      search: this.#filters.search,
      visibleNodeTypes: this.#filters.visibleNodeTypes
        ? new Set(this.#filters.visibleNodeTypes)
        : undefined,
    };
  }

  set filters(value: Partial<ViewFilters>) {
    this.#filters = patchFilters(this.#filters, value);
    this.#paint();
  }

  get session(): CollabSession | undefined {
    return this.#session;
  }

  set session(session: CollabSession | undefined) {
    this.#stop?.();
    this.#stop = undefined;
    this.#session = session;
    this.#resetData();
    this.#mode = { kind: "idle" };
    if (!session) {
      this.#paint();
      return;
    }
    this.#previous = session.snapshot();
    this.#stop = session.onChange((_ops, snapshot) => {
      this.#paint(snapshot);
    });
    this.#ensureNetwork();
    this.#paint(this.#previous);
    this.#catchUp(session);
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = GRAPH_TEMPLATE;
      this.#bind();
    }
    this.#syncVisibleTypes();
    this.#syncChrome();
    this.#ensureNetwork();
    this.#paint();
  }

  disconnectedCallback(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.#network?.destroy();
    this.#network = undefined;
    this.#nodes = undefined;
    this.#edges = undefined;
    window.clearTimeout(this.#searchTimer);
    window.clearTimeout(this.#highlightTimer);
    window.clearTimeout(this.#physicsTimer);
    window.clearTimeout(this.#toastTimer);
  }

  attributeChangedCallback(name: string): void {
    if (name === "visible-types") {
      this.#applyVisibleTypesAttr();
      this.#paint();
      return;
    }
    this.#syncChrome();
    this.#renderInspector();
  }

  #bind(): void {
    const root = this.shadowRoot;
    if (!root) {
      return;
    }
    root.querySelector(".search")?.addEventListener("input", (event) => {
      const value = (event.target as HTMLInputElement).value;
      window.clearTimeout(this.#searchTimer);
      this.#searchTimer = window.setTimeout(() => {
        this.#filters = { ...this.#filters, search: value };
        this.#paint();
      }, 120);
    });
    root.addEventListener("click", (event) => {
      const target = event.target as HTMLElement | null;
      const act = target?.closest<HTMLElement>("[data-act]")?.dataset.act;
      const nodeType = target?.closest<HTMLElement>("[data-node-type]")?.dataset.nodeType;
      const edgeType = target?.closest<HTMLElement>("[data-edge-type]")?.dataset.edgeType;
      const pickNode = target?.closest<HTMLElement>("[data-pick-node]")?.dataset.pickNode;
      const pickEdge = target?.closest<HTMLElement>("[data-pick-edge]")?.dataset.pickEdge;
      if (nodeType) {
        this.#toggleFilter("hiddenNodeTypes", nodeType);
        return;
      }
      if (edgeType) {
        this.#toggleFilter("hiddenEdgeTypes", edgeType);
        return;
      }
      if (pickNode) {
        this.#mode = { kind: "create-node", type: pickNode };
        this.#renderInspector();
        return;
      }
      if (pickEdge) {
        this.#chooseEdgeType(pickEdge);
        return;
      }
      if (act === "add") {
        this.#mode = { kind: "create-node" };
        this.#network?.unselectAll();
        this.#renderInspector();
        return;
      }
      if (act === "link") {
        this.#startLink();
        return;
      }
      if (act === "fit") {
        this.#network?.fit({ animation: { duration: 280, easingFunction: "easeInOutQuad" } });
        return;
      }
      if (act === "layout") {
        this.#relayout();
        return;
      }
      if (act === "delete") {
        void this.#deleteSelection();
        return;
      }
      if (act === "cancel") {
        this.#mode = { kind: "idle" };
        this.#network?.unselectAll();
        this.#renderInspector();
      }
    });
    root.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target as HTMLFormElement | null;
      if (form) {
        void this.#submitForm(form);
      }
    });
    this.addEventListener("keydown", (event) => {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
      if (event.key === "Escape") {
        this.#mode = { kind: "idle" };
        this.#network?.unselectAll();
        this.#renderInspector();
      }
      if (!typing && (event.key === "Delete" || event.key === "Backspace") && this.#editable) {
        event.preventDefault();
        void this.#deleteSelection();
      }
    });
  }

  get #editable(): boolean {
    return attrEnabled(this, "editable", true);
  }

  get #showInspector(): boolean {
    return attrEnabled(this, "inspector", true);
  }

  get #showToolbar(): boolean {
    return attrEnabled(this, "toolbar", true);
  }

  #syncChrome(): void {
    const root = this.shadowRoot;
    if (!root) {
      return;
    }
    const toolbar = root.querySelector<HTMLElement>(".toolbar");
    const inspector = root.querySelector<HTMLElement>(".inspector");
    if (toolbar) {
      toolbar.hidden = !this.#showToolbar;
    }
    if (inspector) {
      inspector.hidden = !this.#showInspector;
    }
    for (const btn of root.querySelectorAll<HTMLButtonElement>("[data-act=add], [data-act=link]")) {
      btn.hidden = !this.#editable;
    }
  }

  #ensureNetwork(): void {
    const canvas = this.shadowRoot?.querySelector<HTMLElement>(".canvas");
    if (!canvas || this.#network) {
      return;
    }
    this.#nodes = new DataSet<ViewNode>([]);
    this.#edges = new DataSet<ViewEdge>([]);
    this.#network = new Network(canvas, { nodes: this.#nodes, edges: this.#edges }, NETWORK_OPTIONS);
    this.#network.on("click", (params: VisClickParams) => this.#onClick(params));
    this.#network.on("stabilizationIterationsDone", () => {
      this.#network?.setOptions({ physics: { enabled: false } });
    });
  }

  #resetData(): void {
    this.#nodes?.clear();
    this.#edges?.clear();
    this.#nodeIds.clear();
    this.#edgeIds.clear();
    this.#projected.clear();
    this.#seeded = false;
    this.#previous = undefined;
  }

  #catchUp(session: CollabSession): void {
    const started = Date.now();
    const tick = () => {
      if (this.#session !== session) {
        return;
      }
      const snap = session.snapshot();
      if (snap.nodes.length > 0 || snap.edges.length > 0) {
        this.#paint(snap);
        return;
      }
      if (Date.now() - started < 2500) {
        window.setTimeout(tick, 50);
      }
    };
    tick();
  }

  #paint(snapshot?: GraphSnapshot): void {
    const session = this.#session;
    const snap = snapshot ?? session?.snapshot();
    this.#syncChrome();
    this.#renderChips(snap);
    this.#renderInspector(snap);
    this.#renderEmpty(snap);
    if (!session || !snap || !this.#nodes || !this.#edges) {
      return;
    }
    const projected = projectGraph(session.schema, snap, this.#filters);
    const plan = planApply(this.#nodeIds, this.#edgeIds, projected);
    if (plan.nodesAdd.length) {
      this.#nodes.add(plan.nodesAdd);
    }
    if (plan.nodesUpdate.length) {
      this.#nodes.update(plan.nodesUpdate);
    }
    if (plan.nodesRemove.length) {
      this.#nodes.remove(plan.nodesRemove);
    }
    if (plan.edgesAdd.length) {
      this.#edges.add(plan.edgesAdd);
    }
    if (plan.edgesUpdate.length) {
      this.#edges.update(plan.edgesUpdate);
    }
    if (plan.edgesRemove.length) {
      this.#edges.remove(plan.edgesRemove);
    }
    this.#nodeIds = new Set(projected.nodes.map((node) => node.id));
    this.#edgeIds = new Set(projected.edges.map((edge) => edge.id));
    this.#projected = new Map(projected.nodes.map((node) => [node.id, node]));
    const first = !this.#seeded;
    if (!first) {
      this.#placeNew(newNodeIds(this.#previous, snap), snap);
      this.#pulse(changedEntityIds(this.#previous, snap));
    } else {
      this.#seeded = true;
      this.#network?.setOptions({ physics: { enabled: true } });
    }
    this.#previous = snap;
    this.#pruneMode(snap);
    this.#renderInspector(snap);
  }

  #placeNew(ids: string[], snapshot: GraphSnapshot): void {
    if (!ids.length || !this.#network || !this.#nodes) {
      return;
    }
    for (const id of ids) {
      const edge = snapshot.edges.find((item) => item.from === id || item.to === id);
      const other = edge ? (edge.from === id ? edge.to : edge.from) : undefined;
      if (!other || !this.#nodeIds.has(other)) {
        continue;
      }
      const pos = this.#network.getPositions([other])[other];
      if (pos) {
        this.#nodes.update({ id, x: pos.x + 52, y: pos.y + 28 });
      }
    }
    this.#network.setOptions({ physics: { enabled: true, stabilization: { enabled: false } } });
    window.clearTimeout(this.#physicsTimer);
    this.#physicsTimer = window.setTimeout(() => {
      this.#network?.setOptions({ physics: { enabled: false } });
    }, 750);
  }

  #pulse(ids: string[]): void {
    if (!ids.length || !this.#nodes) {
      return;
    }
    for (const id of ids) {
      const node = this.#projected.get(id);
      if (node) {
        this.#nodes.update(withPulse(node));
      }
    }
    window.clearTimeout(this.#highlightTimer);
    this.#highlightTimer = window.setTimeout(() => {
      if (!this.#nodes) {
        return;
      }
      for (const id of ids) {
        const node = this.#projected.get(id);
        if (node) {
          this.#nodes.update(node);
        }
      }
    }, 1200);
  }

  #relayout(): void {
    this.#network?.setOptions({
      physics: { enabled: true, stabilization: { enabled: true, iterations: 80, fit: true } },
    });
  }

  #syncVisibleTypes(): void {
    if (!this.hasAttribute("visible-types")) {
      return;
    }
    this.#applyVisibleTypesAttr();
  }

  #applyVisibleTypesAttr(): void {
    this.#filters = patchFilters(this.#filters, {
      visibleNodeTypes: parseVisibleTypes(this.getAttribute("visible-types")) ?? new Set(),
    });
  }

  #toggleFilter(kind: "hiddenNodeTypes" | "hiddenEdgeTypes", type: string): void {
    if (kind === "hiddenNodeTypes") {
      this.#filters = toggleNodeType(this.#filters, type);
      this.#paint();
      return;
    }
    const next = new Set(this.#filters[kind]);
    if (next.has(type)) {
      next.delete(type);
    } else {
      next.add(type);
    }
    this.#filters = { ...this.#filters, [kind]: next };
    this.#paint();
  }

  #renderChips(snapshot: GraphSnapshot | undefined): void {
    const root = this.shadowRoot;
    const schema = this.#session?.schema;
    if (!root || !schema) {
      return;
    }
    const nodeBox = root.querySelector(".chips[data-kind=nodes]");
    const edgeBox = root.querySelector(".chips[data-kind=edges]");
    if (nodeBox) {
      nodeBox.innerHTML = Object.keys(schema.nodes)
        .map((type) => {
          const count = snapshot?.nodes.filter((node) => node.type === type).length ?? 0;
          const off = nodeTypeHidden(this.#filters, type) ? " off" : "";
          const color = typeColor(schema, "node", type);
          return `<button type="button" class="chip${off}" data-node-type="${escapeHtml(type)}"><span class="dot" style="background:${escapeHtml(color)}"></span>${escapeHtml(type)} ${count}</button>`;
        })
        .join("");
    }
    if (edgeBox) {
      edgeBox.innerHTML = Object.keys(schema.edges)
        .map((type) => {
          const count = snapshot?.edges.filter((edge) => edge.type === type).length ?? 0;
          const off = this.#filters.hiddenEdgeTypes.has(type) ? " off" : "";
          const label = resolveI18nString(schema.edges[type]?.ui?.label) ?? type.replaceAll("_", " ").toLowerCase();
          return `<button type="button" class="chip${off}" data-edge-type="${escapeHtml(type)}">${escapeHtml(label)} ${count}</button>`;
        })
        .join("");
    }
  }

  #renderEmpty(snapshot: GraphSnapshot | undefined): void {
    const empty = this.shadowRoot?.querySelector<HTMLElement>(".empty");
    if (!empty) {
      return;
    }
    if (!this.#session) {
      empty.hidden = false;
      empty.textContent = "Connect a collab session to show this graph.";
      return;
    }
    if (!snapshot || snapshot.nodes.length === 0) {
      const first = Object.keys(this.#session.schema.nodes)[0] ?? "node";
      empty.hidden = false;
      empty.textContent = this.#editable
        ? `This graph is empty. Add a ${first} to start.`
        : "This graph is empty.";
      return;
    }
    const visible = projectGraph(this.#session.schema, snapshot, this.#filters).nodes.some((node) => !node.hidden);
    empty.hidden = visible;
    empty.textContent = "Nothing matches the current filters.";
  }

  #renderInspector(snapshot?: GraphSnapshot): void {
    const panel = this.shadowRoot?.querySelector(".inspector");
    if (!panel) {
      return;
    }
    panel.innerHTML = renderInspector(
      this.#session?.schema,
      snapshot ?? this.#session?.snapshot(),
      this.#mode,
      this.#editable,
    );
  }

  #onClick(params: { nodes?: (string | number)[]; edges?: (string | number)[]; event?: { srcEvent?: MouseEvent } }): void {
    const nodeId = params.nodes?.[0] !== undefined ? String(params.nodes[0]) : undefined;
    const edgeId = params.edges?.[0] !== undefined ? String(params.edges[0]) : undefined;
    const shift = Boolean(params.event?.srcEvent?.shiftKey);
    if (this.#mode.kind === "link-pick" || this.#mode.kind === "link-from" || shift) {
      if (nodeId) {
        this.#linkClick(nodeId);
      }
      return;
    }
    if (nodeId) {
      this.#mode = { kind: "inspect-node", id: nodeId };
    } else if (edgeId) {
      this.#mode = { kind: "inspect-edge", id: edgeId };
    } else {
      this.#mode = { kind: "idle" };
    }
    this.dispatchEvent(
      new CustomEvent("collab-inspect", {
        bubbles: true,
        composed: true,
        detail:
          this.#mode.kind === "inspect-node"
            ? { kind: "node", id: this.#mode.id }
            : this.#mode.kind === "inspect-edge"
              ? { kind: "edge", id: this.#mode.id }
              : { kind: "none" },
      }),
    );
    this.#renderInspector();
  }

  #startLink(): void {
    if (!this.#editable) {
      return;
    }
    const selected = this.#network?.getSelectedNodes()?.[0];
    this.#mode = selected ? { kind: "link-from", fromId: String(selected) } : { kind: "link-pick" };
    this.#toast("Click two nodes to connect them.");
    this.#renderInspector();
  }

  #linkClick(nodeId: string): void {
    if (this.#mode.kind === "link-from" && this.#mode.fromId === nodeId) {
      return;
    }
    if (this.#mode.kind !== "link-from") {
      this.#mode = { kind: "link-from", fromId: nodeId };
      this.#renderInspector();
      return;
    }
    this.#openLink(this.#mode.fromId, nodeId);
  }

  #openLink(fromId: string, toId: string): void {
    const session = this.#session;
    const snap = session?.snapshot();
    if (!session || !snap) {
      return;
    }
    const from = snap.nodes.find((node) => node.id === fromId);
    const to = snap.nodes.find((node) => node.id === toId);
    if (!from || !to) {
      this.#toast("Both ends must be nodes.", true);
      return;
    }
    const resolved = resolveLink(session.schema, from.id, to.id, from.type, to.type);
    if (resolved.types.length === 0) {
      this.#mode = { kind: "idle" };
      this.#toast(`No edge type from ${from.type} to ${to.type}.`, true);
      this.#renderInspector();
      return;
    }
    if (resolved.types.length === 1 && resolved.types[0]) {
      this.#chooseEdgeType(resolved.types[0], resolved.fromId, resolved.toId);
      return;
    }
    this.#mode = {
      kind: "link-types",
      fromId: resolved.fromId,
      toId: resolved.toId,
      types: resolved.types,
    };
    this.#renderInspector();
  }

  #chooseEdgeType(type: string, fromId?: string, toId?: string): void {
    const session = this.#session;
    if (!session) {
      return;
    }
    const from =
      fromId ??
      (this.#mode.kind === "link-types" || this.#mode.kind === "create-edge" ? this.#mode.fromId : undefined);
    const to =
      toId ?? (this.#mode.kind === "link-types" || this.#mode.kind === "create-edge" ? this.#mode.toId : undefined);
    if (!from || !to) {
      return;
    }
    const fields = fieldsFor(session.schema, "edge", type);
    if (fields.length === 0) {
      void this.#write(async () => {
        const id = await session.upsertEdge({ type, from, to, properties: {} });
        this.#mode = { kind: "inspect-edge", id };
      });
      return;
    }
    this.#mode = { kind: "create-edge", fromId: from, toId: to, type };
    this.#renderInspector();
  }

  async #submitForm(form: HTMLFormElement): Promise<void> {
    const session = this.#session;
    if (!session || !this.#editable) {
      return;
    }
    const raw = readFormValues(form);
    if (this.#mode.kind === "create-node" && this.#mode.type) {
      const parsed = propertiesFromForm(fieldsFor(session.schema, "node", this.#mode.type), raw);
      if (!parsed.ok) {
        this.#toast(parsed.error, true);
        return;
      }
      const type = this.#mode.type;
      await this.#write(async () => {
        const id = await session.upsertNode({
          type,
          properties: parsed.properties,
          tags: tagsFromForm(session.schema, raw),
        });
        this.#mode = { kind: "inspect-node", id };
      });
      return;
    }
    if (this.#mode.kind === "inspect-node") {
      const nodeId = this.#mode.id;
      const node = session.snapshot().nodes.find((item) => item.id === nodeId);
      if (!node) {
        return;
      }
      const parsed = propertiesFromForm(
        fieldsFor(session.schema, "node", node.type, { crdt: "omit" }),
        raw,
        {
          emptyAs: "null",
        },
      );
      if (!parsed.ok) {
        this.#toast(parsed.error, true);
        return;
      }
      await this.#write(async () => {
        await session.upsertNode({
          type: node.type,
          id: node.id,
          properties: parsed.properties,
          tags: tagsFromForm(session.schema, raw, node.tags ?? []),
        });
      });
      return;
    }
    if (this.#mode.kind === "create-edge") {
      const parsed = propertiesFromForm(fieldsFor(session.schema, "edge", this.#mode.type), raw);
      if (!parsed.ok) {
        this.#toast(parsed.error, true);
        return;
      }
      const { fromId, toId, type } = this.#mode;
      await this.#write(async () => {
        const id = await session.upsertEdge({ type, from: fromId, to: toId, properties: parsed.properties });
        this.#mode = { kind: "inspect-edge", id };
      });
      return;
    }
    if (this.#mode.kind === "inspect-edge") {
      const edgeId = this.#mode.id;
      const edge = session.snapshot().edges.find((item) => item.id === edgeId);
      if (!edge) {
        return;
      }
      const parsed = propertiesFromForm(fieldsFor(session.schema, "edge", edge.type), raw, {
        emptyAs: "null",
      });
      if (!parsed.ok) {
        this.#toast(parsed.error, true);
        return;
      }
      await this.#write(async () => {
        await session.upsertEdge({
          type: edge.type,
          id: edge.id,
          from: edge.from,
          to: edge.to,
          properties: parsed.properties,
        });
      });
    }
  }

  async #deleteSelection(): Promise<void> {
    const session = this.#session;
    if (!session || !this.#editable) {
      return;
    }
    if (this.#mode.kind === "inspect-node") {
      const id = this.#mode.id;
      const node = session.snapshot().nodes.find((item) => item.id === id);
      const label = node ? node.type : "node";
      if (!window.confirm(`Delete this ${label}?`)) {
        return;
      }
      await this.#write(async () => {
        await session.deleteNode(id);
        this.#mode = { kind: "idle" };
      });
      return;
    }
    if (this.#mode.kind === "inspect-edge") {
      const id = this.#mode.id;
      if (!window.confirm("Delete this link?")) {
        return;
      }
      await this.#write(async () => {
        await session.deleteEdge(id);
        this.#mode = { kind: "idle" };
      });
    }
  }

  #pruneMode(snapshot: GraphSnapshot): void {
    if (this.#mode.kind === "inspect-node") {
      const id = this.#mode.id;
      if (!snapshot.nodes.some((node) => node.id === id)) {
        this.#mode = { kind: "idle" };
      }
    }
    if (this.#mode.kind === "inspect-edge") {
      const id = this.#mode.id;
      if (!snapshot.edges.some((edge) => edge.id === id)) {
        this.#mode = { kind: "idle" };
      }
    }
  }

  async #write(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.#paint();
    } catch (error) {
      this.#toast(error instanceof Error ? error.message : String(error), true);
    }
  }

  #toast(message: string, error = false): void {
    const el = this.shadowRoot?.querySelector<HTMLElement>(".toast");
    if (!el) {
      return;
    }
    el.textContent = message;
    el.classList.toggle("error", error);
    el.hidden = false;
    window.clearTimeout(this.#toastTimer);
    this.#toastTimer = window.setTimeout(() => {
      el.hidden = true;
    }, 3200);
  }
}

if (typeof customElements !== "undefined" && !customElements.get(CollabGraph.tagName)) {
  customElements.define(CollabGraph.tagName, CollabGraph);
}

declare global {
  interface HTMLElementTagNameMap {
    "collab-graph": CollabGraph;
  }
}
