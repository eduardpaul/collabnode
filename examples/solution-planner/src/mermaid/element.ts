import type { CollabSession } from "@collabnode/runtime";

type GraphSnapshot = ReturnType<CollabSession["snapshot"]>;
import mermaid from "mermaid";
import { snapshotToMermaid } from "./dsl.ts";

const TEMPLATE = `
  <style>
    :host {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 180px;
      background: var(--panel, #090d16);
      color: var(--text, #e8edf7);
      overflow: hidden;
    }
    .wrap {
      width: 100%;
      height: 100%;
      overflow: auto;
      padding: 8px;
      box-sizing: border-box;
    }
    .wrap svg {
      max-width: 100%;
      height: auto;
    }
    .empty, .error {
      font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
      color: #94a3b8;
      padding: 12px;
    }
    .error { color: #f87171; white-space: pre-wrap; }
  </style>
  <div class="wrap" part="canvas"></div>
`;

let mermaidReady = false;
let renderSeq = 0;

function ensureMermaid(): void {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    flowchart: { htmlLabels: false, curve: "basis" },
  });
  mermaidReady = true;
}

/**
 * `mermaid.initialize` is process-global, so it cannot carry a per-element
 * theme — the first element to render would pin the theme for every other one.
 * An `init` directive on the diagram itself is scoped to that render.
 * (`theme` is not a `secure` key, so strict security level still honours it.)
 */
function withTheme(dsl: string, theme: string): string {
  const resolved = theme === "default" ? "default" : "dark";
  return `%%{init: {"theme": "${resolved}"}}%%\n${dsl}`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Planner-only: snapshot nodes → Mermaid DSL → mermaid.js SVG. */
export class CollabMermaid extends HTMLElement {
  static readonly tagName = "collab-mermaid";
  static readonly observedAttributes = ["visible-types", "direction", "theme", "kind"];

  #session: CollabSession | undefined;
  #stop: (() => void) | undefined;
  #dsl = "";
  #renderGen = 0;

  get session(): CollabSession | undefined {
    return this.#session;
  }

  set session(session: CollabSession | undefined) {
    this.#stop?.();
    this.#stop = undefined;
    this.#session = session;
    if (!session) {
      this.#paint();
      return;
    }
    this.#subscribe();
    this.#paint(session.snapshot());
  }

  /** Idempotent: safe to call on every connect. */
  #subscribe(): void {
    if (this.#stop || !this.#session) return;
    this.#stop = this.#session.onChange((_ops, snapshot) => {
      this.#paint(snapshot);
    });
  }

  get dsl(): string {
    return this.#dsl;
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = TEMPLATE;
    }
    // disconnectedCallback drops the subscription; moving the element in the DOM
    // must restore it, or the diagram freezes at whatever it last rendered.
    this.#subscribe();
    this.#paint(this.#session?.snapshot());
  }

  disconnectedCallback(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  attributeChangedCallback(): void {
    this.#paint(this.#session?.snapshot());
  }

  #paint(snapshot?: GraphSnapshot): void {
    const wrap = this.shadowRoot?.querySelector(".wrap");
    if (!wrap) return;

    if (!snapshot || !this.#session) {
      wrap.innerHTML = `<div class="empty">Connect a collab session to show this diagram.</div>`;
      this.#dsl = "";
      return;
    }

    const visibleTypes = this.getAttribute("visible-types");
    const direction = this.getAttribute("direction") === "LR" ? "LR" : "TB";
    const kindAttr = this.getAttribute("kind");
    const kind = kindAttr === "c4" || kindAttr === "flowchart" ? kindAttr : "auto";
    const dsl = snapshotToMermaid(snapshot, this.#session.schema, { visibleTypes, direction, kind });
    this.#dsl = dsl;

    const gen = ++this.#renderGen;
    ensureMermaid();
    const id = `cnm${++renderSeq}`;
    void mermaid
      .render(id, withTheme(dsl, this.getAttribute("theme") ?? "dark"))
      .then(({ svg }) => {
        if (gen !== this.#renderGen || !this.shadowRoot) return;
        wrap.innerHTML = svg;
      })
      .catch((err: unknown) => {
        if (gen !== this.#renderGen || !this.shadowRoot) return;
        const message = err instanceof Error ? err.message : String(err);
        wrap.innerHTML = `<div class="error">${escapeHtml(message)}\n\n${escapeHtml(dsl)}</div>`;
      });
  }
}

if (typeof customElements !== "undefined" && !customElements.get(CollabMermaid.tagName)) {
  customElements.define(CollabMermaid.tagName, CollabMermaid);
}
