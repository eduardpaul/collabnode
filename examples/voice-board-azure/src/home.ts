import { strings, type UiLanguage } from "./i18n.ts";

/**
 * The homepage: every live board as a card, plus one create tile per board
 * type. Both lists come off the server (`/api/boards`, `/api/board-types`),
 * and the types carry their own `params:` fields, so this file has no idea
 * that "voice board" and "C4 architecture" are the two kinds that exist — add
 * a third YAML and its tile appears here with the right form.
 */

interface BoardParamField {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description: string;
}

export interface BoardTypeSummary {
  typeName: string;
  emoji: string;
  title: string;
  description: string;
  params: BoardParamField[];
}

export interface BoardSummary {
  id: string;
  typeName: string;
  emoji: string;
  name: string;
  typeTitle: string;
  description: string;
  createdAt: string;
  nodes: number;
  edges: number;
  mcp: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function initials(actor: string): string {
  return String(actor ?? "??").slice(0, 2).toUpperCase();
}

/** Preserves `?as=` and `?lang=` when moving between the homepage and a board. */
function boardHref(id: string, actor: string, lang: UiLanguage): string {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("workspace", id);
  url.searchParams.set("as", actor);
  url.searchParams.set("lang", lang);
  return url.toString();
}

/**
 * One input for one `params:` entry. `data-param` carries the YAML's declared
 * type across to submit time, where the value has to be sent back as that type
 * — `validateParams` on the server rejects a number arriving as a string.
 */
function paramControl(param: BoardParamField): string {
  const id = `param-${escapeHtml(param.name)}`;
  const name = escapeHtml(param.name);
  const type = escapeHtml(param.type);

  if (param.type === "boolean") {
    const checked = param.default === true ? "checked" : "";
    return `<input type="checkbox" id="${id}" name="${name}" data-param="${type}" ${checked} />`;
  }

  const inputType = param.type === "number" ? "number" : "text";
  const value = param.default === undefined ? "" : escapeHtml(param.default);
  const required = param.required ? "required" : "";
  return `<input
    type="${inputType}"
    id="${id}"
    name="${name}"
    data-param="${type}"
    value="${value}"
    ${required}
  />`;
}

export async function mountHome(root: Element, actor: string, lang: UiLanguage): Promise<void> {
  const t = strings(lang);
  document.title = `${t.home.title} — collabnode`;

  root.innerHTML = `
    <header class="topbar">
      <div>
        <h1>${escapeHtml(t.home.title)}</h1>
        <p class="sub">${escapeHtml(t.home.subtitle)}</p>
      </div>
      <div class="topbar-right">
        <div class="who" title="${escapeHtml(t.header.signedInAs(actor))}">${escapeHtml(initials(actor))}</div>
      </div>
    </header>

    <section class="home-section" aria-labelledby="home-create">
      <div class="home-head">
        <h2 id="home-create">${escapeHtml(t.home.createHeading)}</h2>
        <p class="sub">${escapeHtml(t.home.createHint)}</p>
      </div>
      <div class="type-grid" data-type-grid></div>
    </section>

    <section class="home-section" aria-labelledby="home-boards">
      <div class="home-head">
        <h2 id="home-boards">${escapeHtml(t.home.yourBoards)}</h2>
      </div>
      <div class="board-grid" data-board-grid></div>
    </section>

    <dialog class="create-dialog" data-create-dialog>
      <form method="dialog" data-create-form></form>
    </dialog>
  `;

  const typeGrid = root.querySelector<HTMLElement>("[data-type-grid]");
  const boardGrid = root.querySelector<HTMLElement>("[data-board-grid]");
  const dialog = root.querySelector<HTMLDialogElement>("[data-create-dialog]");
  const form = root.querySelector<HTMLFormElement>("[data-create-form]");
  if (!typeGrid || !boardGrid || !dialog || !form) {
    return;
  }

  let types: BoardTypeSummary[] = [];

  const renderTypes = (): void => {
    typeGrid.innerHTML = types
      .map(
        (type) => `
        <button type="button" class="type-card" data-new-board="${escapeHtml(type.typeName)}">
          <span class="type-emoji" aria-hidden="true">${escapeHtml(type.emoji)}</span>
          <span class="type-body">
            <span class="type-title">${escapeHtml(type.title)}</span>
            <span class="type-desc">${escapeHtml(type.description)}</span>
          </span>
          <span class="type-cta">+ ${escapeHtml(t.home.newBoard)}</span>
        </button>
      `,
      )
      .join("");
  };

  const renderBoards = (boards: BoardSummary[]): void => {
    if (boards.length === 0) {
      boardGrid.innerHTML = `<p class="sub">${escapeHtml(t.home.empty)}</p>`;
      return;
    }
    boardGrid.innerHTML = boards
      .map(
        (board) => `
        <article class="board-card">
          <a class="board-card-main" href="${escapeHtml(boardHref(board.id, actor, lang))}">
            <span class="board-emoji" aria-hidden="true">${escapeHtml(board.emoji)}</span>
            <h3 class="board-name">${escapeHtml(board.name)}</h3>
            <span class="board-type">${escapeHtml(board.typeTitle)}</span>
            <span class="board-counts">${escapeHtml(t.home.counts(board.nodes, board.edges))}</span>
          </a>
          <div class="board-card-foot">
            <code class="board-id">${escapeHtml(board.id)}</code>
            <button
              type="button"
              class="board-delete"
              data-delete-board="${escapeHtml(board.id)}"
              data-board-name="${escapeHtml(board.name)}"
              title="${escapeHtml(t.home.removeTitle(board.name))}"
            >${escapeHtml(t.home.remove)}</button>
          </div>
        </article>
      `,
      )
      .join("");
  };

  const refresh = async (): Promise<void> => {
    const response = await fetch(`/api/boards?lang=${lang}`);
    if (!response.ok) {
      throw new Error(t.home.loadFailed);
    }
    renderBoards((await response.json()) as BoardSummary[]);
  };

  /**
   * The create form is generated from the type's `params:`. A C4 board asks for
   * a system name and a primary user because its YAML declares them; the voice
   * board asks for an author. Defaults come from the YAML too, so submitting
   * the form untouched is the same as accepting them.
   */
  const openCreateDialog = (type: BoardTypeSummary): void => {
    const fields = type.params
      .map(
        (param) => `
          <label class="field" for="param-${escapeHtml(param.name)}">
            <span class="field-label">${escapeHtml(param.description || param.name)}</span>
            ${paramControl(param)}
          </label>
        `,
      )
      .join("");

    form.innerHTML = `
      <h2 class="dialog-title">
        <span aria-hidden="true">${escapeHtml(type.emoji)}</span>
        ${escapeHtml(t.home.dialogTitle(type.title))}
      </h2>
      <label class="field" for="board-name">
        <span class="field-label">${escapeHtml(t.home.nameLabel)} <em>(${escapeHtml(t.home.optional)})</em></span>
        <input type="text" id="board-name" name="__name" placeholder="${escapeHtml(t.home.namePlaceholder)}" />
      </label>
      ${fields}
      <p class="dialog-error" data-dialog-error hidden></p>
      <div class="dialog-actions">
        <button type="button" class="link" data-cancel>${escapeHtml(t.home.cancel)}</button>
        <button type="submit" class="primary" data-submit>${escapeHtml(t.home.create)}</button>
      </div>
    `;
    form.dataset.typeName = type.typeName;
    dialog.showModal();
    form.querySelector<HTMLInputElement>("#board-name")?.focus();
  };

  typeGrid.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-new-board]");
    const type = types.find((candidate) => candidate.typeName === button?.dataset.newBoard);
    if (type) {
      openCreateDialog(type);
    }
  });

  form.addEventListener("click", (event) => {
    if ((event.target as HTMLElement).closest("[data-cancel]")) {
      dialog.close();
    }
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>("[data-submit]");
    const error = form.querySelector<HTMLElement>("[data-dialog-error]");
    const typeName = form.dataset.typeName;
    if (!typeName || !submit || !error) {
      return;
    }

    // The YAML declares each param's type, so a `number:` param has to be sent
    // as a number — `validateParams` on the server rejects the string form.
    const params: Record<string, unknown> = {};
    let name = "";
    for (const input of form.querySelectorAll<HTMLInputElement>("input")) {
      if (input.name === "__name") {
        name = input.value.trim();
        continue;
      }
      if (input.dataset.param === "boolean") {
        params[input.name] = input.checked;
      } else if (input.dataset.param === "number") {
        if (input.value.trim()) {
          params[input.name] = Number(input.value);
        }
      } else if (input.value.trim()) {
        params[input.name] = input.value.trim();
      }
    }

    submit.disabled = true;
    submit.textContent = t.home.creating;
    error.hidden = true;

    void (async () => {
      try {
        const response = await fetch("/api/boards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ typeName, name, params }),
        });
        const body = (await response.json()) as BoardSummary & { error?: string };
        if (!response.ok) {
          throw new Error(body.error || t.home.createFailed);
        }
        // Straight into the board that was just created — creating one and then
        // hunting for its card is a step nobody wants.
        location.href = boardHref(body.id, actor, lang);
      } catch (cause) {
        error.textContent = cause instanceof Error ? cause.message : t.home.createFailed;
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = t.home.create;
      }
    })();
  });

  boardGrid.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-delete-board]");
    if (!button) {
      return;
    }
    const id = button.dataset.deleteBoard;
    const name = button.dataset.boardName ?? id ?? "";
    if (!id || !window.confirm(t.home.confirmRemove(name))) {
      return;
    }
    button.disabled = true;
    void fetch(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" })
      .then(() => refresh())
      .catch(() => {
        button.disabled = false;
      });
  });

  try {
    const typesResponse = await fetch(`/api/board-types?lang=${lang}`);
    types = (await typesResponse.json()) as BoardTypeSummary[];
    renderTypes();
    await refresh();
  } catch {
    boardGrid.innerHTML = `<p class="sub">${escapeHtml(t.home.loadFailed)}</p>`;
  }
}
