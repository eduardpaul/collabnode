export const GRAPH_TEMPLATE = `
  <style>
    :host {
      display: block;
      height: 100%;
      min-height: 420px;
      background: var(--panel, #10131c);
      border: 1px solid var(--line, #1e2433);
      border-radius: 14px;
      color: var(--text, #e8edf7);
      font-family: inherit;
      overflow: hidden;
    }
    .shell {
      /* Flex, not grid rows: with the toolbar hidden it is no longer a grid
         item, so a two-row template drops .body into the auto row and the
         canvas collapses to zero height. */
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: inherit;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      padding: 10px 12px;
      flex: none;
      border-bottom: 1px solid var(--line, #1e2433);
      background: var(--panel, #10131c);
    }
    .toolbar[hidden], .inspector[hidden] { display: none !important; }
    .search {
      flex: 1 1 180px;
      min-width: 140px;
      background: #0b0e16;
      border: 1px solid var(--line, #1e2433);
      color: inherit;
      border-radius: 10px;
      padding: 8px 10px;
      font: inherit;
      font-size: 13px;
    }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip, .btn {
      font: inherit;
      cursor: pointer;
      border-radius: 999px;
      border: 1px solid var(--line, #1e2433);
      background: #0b0e16;
      color: inherit;
      padding: 6px 10px;
      font-size: 12px;
      line-height: 1.2;
    }
    .chip { display: inline-flex; align-items: center; gap: 6px; }
    .chip.off { opacity: 0.4; }
    .chip .dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--accent, #6ea8fe);
    }
    .btn.primary {
      background: var(--accent, #6ea8fe);
      color: #071018;
      border-color: transparent;
      font-weight: 650;
    }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
    .body {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 300px;
      flex: 1 1 auto;
      min-height: 0;
    }
    :host([inspector="false"]) .body { grid-template-columns: minmax(0, 1fr); }
    .stage { position: relative; min-height: 0; background: #0b0e16; }
    .canvas { position: absolute; inset: 0; }
    .canvas .vis-network, .canvas canvas { outline: none; }
    .empty {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      margin: 0;
      padding: 24px;
      text-align: center;
      color: var(--muted, #8b95ab);
      font-size: 14px;
      pointer-events: none;
    }
    .empty[hidden] { display: none; }
    .inspector {
      border-left: 1px solid var(--line, #1e2433);
      padding: 14px;
      overflow: auto;
      background: var(--panel, #10131c);
    }
    .inspector h2 {
      margin: 0;
      font-size: 12px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--muted, #8b95ab);
    }
    .inspector .hint, .inspector .meta, .inspector .guidelines {
      color: var(--muted, #8b95ab);
      font-size: 12px;
      line-height: 1.45;
    }
    .inspector .hint { margin: 8px 0 12px; }
    .inspector .error {
      color: #ff5d73;
      font-size: 12px;
      margin: 0 0 10px;
    }
    .inspector form { display: grid; gap: 10px; }
    .inspector label { display: grid; gap: 4px; font-size: 12px; color: var(--muted, #8b95ab); }
    .inspector input, .inspector select, .inspector textarea {
      background: #0b0e16;
      border: 1px solid var(--line, #1e2433);
      color: inherit;
      border-radius: 8px;
      padding: 8px 10px;
      font: inherit;
      font-size: 13px;
      width: 100%;
    }
    .inspector textarea { min-height: 72px; resize: vertical; }
    .inspector label.check {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text, #e8edf7);
    }
    .inspector label.check input { width: auto; }
    .inspector .slider, .inspector label.slider { display: grid; gap: 4px; font-size: 12px; color: var(--muted, #8b95ab); }
    .inspector .slider-row { display: flex; align-items: center; gap: 8px; }
    .inspector .slider-row input[type="range"] { flex: 1; padding: 8px 0; }
    .inspector .slider:has([data-slider-enable]):not(:has([data-slider-enable]:checked)) input[type="range"] {
      opacity: 0.45;
      pointer-events: none;
    }
    .type-list { display: grid; gap: 6px; margin: 10px 0; }
    .type-list button {
      text-align: left;
      font: inherit;
      cursor: pointer;
      background: #0b0e16;
      border: 1px solid var(--line, #1e2433);
      color: inherit;
      border-radius: 10px;
      padding: 10px;
    }
    .type-list button:hover { border-color: var(--accent, #6ea8fe); }
    .type-list small { display: block; color: var(--muted, #8b95ab); font-size: 11px; margin-top: 4px; }
    .inspector-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    .btn.danger { color: #ff5d73; border-color: #5a2430; }
    .guidelines { margin: 12px 0 0; padding-left: 16px; }
    .toast {
      position: absolute;
      left: 12px;
      bottom: 12px;
      background: #10131c;
      border: 1px solid var(--line, #1e2433);
      border-radius: 10px;
      padding: 8px 12px;
      font-size: 12px;
      color: var(--text, #e8edf7);
      max-width: min(420px, calc(100% - 24px));
      z-index: 4;
    }
    .toast[hidden] { display: none; }
    .toast.error { border-color: #5a2430; color: #ffb4be; }
    .vis-tooltip {
      position: absolute;
      padding: 6px 10px;
      background: #10131c;
      border: 1px solid #1e2433;
      color: #e8edf7;
      font-size: 12px;
      line-height: 1.35;
      border-radius: 8px;
      pointer-events: none;
      white-space: pre-wrap;
      z-index: 5;
    }
    @media (max-width: 800px) {
      .body { grid-template-columns: 1fr; grid-template-rows: minmax(280px, 1fr) auto; }
      .inspector { border-left: 0; border-top: 1px solid var(--line, #1e2433); max-height: 46vh; }
      .actions { margin-left: 0; }
    }
  </style>
  <div class="shell">
    <div class="toolbar" part="toolbar">
      <input class="search" type="search" placeholder="Search nodes and edges" aria-label="Search graph" />
      <div class="chips" data-kind="nodes"></div>
      <div class="chips" data-kind="edges"></div>
      <div class="actions">
        <button type="button" class="btn primary" data-act="add">+ Node</button>
        <button type="button" class="btn" data-act="link">Link</button>
        <button type="button" class="btn" data-act="fit">Fit</button>
        <button type="button" class="btn" data-act="layout">Re-layout</button>
      </div>
    </div>
    <div class="body">
      <div class="stage">
        <div class="canvas" part="canvas" role="img" aria-label="Live graph"></div>
        <p class="empty" hidden></p>
        <div class="toast" hidden></div>
      </div>
      <aside class="inspector" part="inspector"></aside>
    </div>
  </div>
`;
