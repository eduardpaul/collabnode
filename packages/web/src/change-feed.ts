import type { GraphSnapshot } from "@collabnode/graph";
import type { CollabSession } from "@collabnode/runtime";
import {
  describeHistory,
  describeLastWrites,
  describeOps,
  formatChangeTime,
  type ChangeEvent,
} from "./changes.js";
import { escapeHtml } from "./html.js";

const TEMPLATE = `
  <style>
    :host {
      display: block;
      background: var(--panel, #10131c);
      border: 1px solid var(--line, #1e2433);
      border-radius: 14px;
      color: var(--text, #e8edf7);
      min-height: 320px;
      max-height: 70vh;
      overflow: auto;
      font-family: inherit;
    }
    header {
      position: sticky;
      top: 0;
      background: var(--panel, #10131c);
      padding: 14px 14px 10px;
      border-bottom: 1px solid var(--line, #1e2433);
    }
    h2 {
      margin: 0;
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted, #8b95ab);
    }
    p.hint {
      margin: 6px 0 0;
      color: var(--muted, #8b95ab);
      font-size: 12px;
      line-height: 1.4;
    }
    p.hint[hidden] { display: none; }
    ol { list-style: none; margin: 0; padding: 8px 14px 14px; }
    li {
      padding: 10px 0;
      border-bottom: 1px solid var(--line, #1e2433);
      font-size: 13px;
      line-height: 1.4;
    }
    li:last-child { border-bottom: 0; }
    .who {
      color: var(--accent, #6ea8fe);
      font-weight: 650;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .when { float: right; color: var(--muted, #8b95ab); font-size: 11px; }
    .empty { color: var(--muted, #8b95ab); font-size: 13px; padding: 4px 0; }
  </style>
  <header>
    <h2>Change tracking</h2>
    <p class="hint">Last-write on join, then live ops from every peer.</p>
  </header>
  <ol part="feed" aria-live="polite" aria-relevant="additions"></ol>
`;

export class CollabChangeFeed extends HTMLElement {
  static readonly tagName = "collab-change-feed";

  #session: CollabSession | undefined;
  #stop: (() => void) | undefined;
  #previous: GraphSnapshot | undefined;
  #entries: ChangeEvent[] = [];
  #max = 80;

  get session(): CollabSession | undefined {
    return this.#session;
  }

  set session(session: CollabSession | undefined) {
    this.#stop?.();
    this.#stop = undefined;
    this.#session = session;
    if (!session) {
      this.#entries = [];
      this.#previous = undefined;
      this.#render();
      return;
    }
    this.#previous = session.snapshot();
    if (this.#historyMode(session)) {
      this.#entries = describeHistory(session.history()).slice(0, this.#max);
      this.#render();
      this.#stop = session.onChange(() => {
        if (this.#session !== session) {
          return;
        }
        this.#previous = session.snapshot();
        this.#entries = describeHistory(session.history()).slice(0, this.#max);
        this.#render();
      });
    } else {
      this.#entries = describeLastWrites(this.#previous);
      this.#render();
      this.#stop = session.onChange((ops, snapshot) => {
        const live = describeOps(ops, snapshot, this.#previous);
        this.#previous = snapshot;
        this.#entries = [...live.reverse(), ...this.#entries].slice(0, this.#max);
        this.#render();
      });
    }
    this.#catchUp(session);
  }

  #historyMode(session: CollabSession): boolean {
    return (
      session.schema.config.changeTracking.enabled &&
      session.schema.config.changeTracking.mode === "history"
    );
  }

  /** Fluid may finish loading after join(); pull history or last-writes once the tree is actually there. */
  #catchUp(session: CollabSession): void {
    const started = Date.now();
    const tick = () => {
      if (this.#session !== session) {
        return;
      }
      if (this.#historyMode(session)) {
        const hist = describeHistory(session.history());
        if (hist.length > 0 && this.#entries.length === 0) {
          this.#previous = session.snapshot();
          this.#entries = hist.slice(0, this.#max);
          this.#render();
          return;
        }
      } else {
        const snap = session.snapshot();
        const last = describeLastWrites(snap);
        if (last.length > 0 && this.#entries.length === 0) {
          this.#previous = snap;
          this.#entries = last;
          this.#render();
          return;
        }
      }
      if (this.#entries.length === 0 && Date.now() - started < 2500) {
        setTimeout(tick, 50);
      }
    };
    tick();
  }

  connectedCallback(): void {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }
    this.#render();
  }

  disconnectedCallback(): void {
    this.#stop?.();
    this.#stop = undefined;
  }

  #render(): void {
    const root = this.shadowRoot ?? this.attachShadow({ mode: "open" });
    if (!root.querySelector("style")) {
      root.innerHTML = TEMPLATE;
    }
    const hint = root.querySelector("p.hint");
    if (hint) {
      const history = this.#session ? this.#historyMode(this.#session) : false;
      hint.textContent = history
        ? "Durable history for this document, including after refresh."
        : "Last-write on join, then live ops from every peer.";
    }
    const list = root.querySelector("ol");
    if (!list) {
      return;
    }
    if (this.#entries.length === 0) {
      list.innerHTML =
        `<li class="empty">No tracked changes yet. Enable config.changeTracking and pass actorId.</li>`;
      return;
    }
    list.innerHTML = this.#entries
      .map(
        (event) => `
          <li>
            <span class="who">${escapeHtml(event.actor)}</span>
            <span class="when">${escapeHtml(formatChangeTime(event.at))}</span>
            <div>${escapeHtml(event.text)}</div>
          </li>
        `,
      )
      .join("");
  }
}

if (typeof customElements !== "undefined" && !customElements.get(CollabChangeFeed.tagName)) {
  customElements.define(CollabChangeFeed.tagName, CollabChangeFeed);
}

declare global {
  interface HTMLElementTagNameMap {
    "collab-change-feed": CollabChangeFeed;
  }
}
