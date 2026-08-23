import { connect, httpTokenProvider, type WebCollab } from "@collabnode/web";
import { CollabGraph } from "@collabnode/graph-view";
import { bindCollabText } from "./bind-text.ts";
import { startVoice, type VoiceHandle, type VoiceState } from "./voice-client.ts";
import { mountHome, type BoardSummary } from "./home.ts";
import { strings, uiLanguage } from "./i18n.ts";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

function initials(actor: string): string {
  return String(actor ?? "??").slice(0, 2).toUpperCase();
}

function excerpt(body: string): string {
  const line = body
    .split("\n")
    .map((part) => part.replace(/^[#>\-*\s]+/, "").trim())
    .find((part) => part.length > 0);
  if (!line) {
    return "";
  }
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function micError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|denied|NotAllowed/i.test(message)) {
    return t.mic.denied;
  }
  if (/NotFound|device/i.test(message)) {
    return t.mic.missing;
  }
  return t.mic.failed;
}

/**
 * Status and priority are stored as the schema's enum values, which the model
 * and the tools both key off. Only the badge is translated — the value written
 * to the graph stays `todo` / `done`, so a Spanish and an English tab can edit
 * the same task without fighting.
 */
function statusLabel(status: string): string {
  return t.board.status[status as keyof typeof t.board.status] ?? status;
}

function priorityLabel(priority: string): string {
  return t.board.priority[priority as keyof typeof t.board.priority] ?? priority;
}

function describeTool(tool: string, detail: string): string {
  const subject = detail.includes(" — ") ? detail.slice(detail.indexOf(" — ") + 3) : "";
  const quoted = subject ? `“${subject}”` : "";
  if (tool === "dictate_note" || tool === "upsert_node_Note") {
    return t.tool.savedNote(quoted);
  }
  if (tool === "add_task" || tool === "upsert_node_Task") {
    return t.tool.createdTask(quoted);
  }
  if (tool === "add_container" || tool === "upsert_node_Container") {
    return t.tool.addedContainer(quoted);
  }
  if (tool === "add_component" || tool === "upsert_node_Component") {
    return t.tool.addedComponent(quoted);
  }
  if (tool === "upsert_node_SoftwareSystem") {
    return t.tool.definedSystem(quoted);
  }
  if (tool === "upsert_node_Person") {
    return t.tool.addedPerson(subject);
  }
  if (tool === "upsert_edge_AUTHORED") {
    return t.tool.linkedAuthor;
  }
  if (tool === "upsert_edge_ASSIGNED_TO") {
    return t.tool.assignedTask;
  }
  if (tool === "upsert_edge_PRODUCES_TASK") {
    return t.tool.linkedTaskToNote;
  }
  if (tool === "upsert_edge_USES") {
    return t.tool.connectedDependency;
  }
  if (tool === "upsert_edge_CONTAINS") {
    return t.tool.nestedComponent;
  }
  if (tool === "graph_get") {
    return t.tool.opened(quoted);
  }
  if (tool === "graph_neighbors") {
    return t.tool.checkedArchitecture;
  }
  if (tool === "graph_list" || tool === "graph_search") {
    return t.tool.searched;
  }
  return detail;
}

const searchParams = new URLSearchParams(location.search);
const actorId = searchParams.get("as")?.trim() || "ada";
/**
 * The whole router: `?workspace=<id>` is a board, no `?workspace=` is the
 * homepage. Boards are created and deleted at runtime now, so there is no
 * default board to fall back to — an id that names nothing is an error with a
 * way back, not somebody else's notes.
 */
const workspaceId = searchParams.get("workspace")?.trim() ?? "";

/**
 * One language for the whole page: `?lang=` wins so a link can pin it, then
 * the browser's own preference. The same code is sent to the server, so the
 * schema text, the tool catalog, and Echo's replies all agree with the chrome.
 */
const lang = uiLanguage(searchParams.get("lang") ?? navigator.language);
const t = strings(lang);
document.documentElement.lang = t.htmlLang;

const app = document.querySelector("#app");

if (!app) {
  throw new Error("#app missing");
}
app.textContent = t.connecting;

if (!workspaceId) {
  await mountHome(app, actorId, lang);
} else {
  try {
    const boardsResponse = await fetch(`/api/boards?lang=${lang}`);
    const boardList = (await boardsResponse.json()) as BoardSummary[];
    const client = await connectToBoard(actorId, workspaceId);
    mount(app, client, actorId, workspaceId, boardList);
  } catch (error) {
    showBoardError(app, error instanceof Error ? error.message : String(error));
  }
}

/** URL of the homepage, keeping the identity and language of the current tab. */
function homeHref(): string {
  const url = new URL(location.href);
  url.search = "";
  url.searchParams.set("as", actorId);
  url.searchParams.set("lang", lang);
  return url.toString();
}

function showBoardError(root: Element, message: string): void {
  document.title = `${t.home.title} — collabnode`;
  root.innerHTML = `
    <div class="board-error">
      <p>${escapeHtml(message)}</p>
      <a class="link" href="${escapeHtml(homeHref())}">${escapeHtml(t.home.backToBoards)}</a>
    </div>
  `;
}

async function connectToBoard(actor: string, wsId: string): Promise<WebCollab & { typeName: string }> {
  const response = await fetch(`/api/collab/join?workspace=${encodeURIComponent(wsId)}&lang=${lang}`);
  if (response.status === 404) {
    throw new Error(t.home.notFound);
  }
  if (!response.ok) {
    throw new Error(`join failed: ${response.status}`);
  }
  const join = (await response.json()) as {
    documentId: string;
    typeName: string;
    schema: Parameters<typeof connect>[0]["schema"];
    collab: Parameters<typeof connect>[0]["collab"];
  };
  const webCollab = await connect({
    schema: join.schema,
    documentId: join.documentId,
    actorId: actor,
    collab: withTokenProvider(join.collab, actor),
  });
  return Object.assign(webCollab, { typeName: join.typeName });
}

/**
 * The server describes *which* relay to join; it cannot hand over the means to
 * join it. The tenant key never leaves the server, so the browser fetches a
 * token per document from /api/fluid/token instead — that route is the only
 * place where the key and the question "may this person open this board?" meet.
 *
 * Left alone for every other backend: Tinylicious and Hocuspocus need no token,
 * so a local run of this same app still works by deleting the .env.
 */
function withTokenProvider(
  collab: Parameters<typeof connect>[0]["collab"],
  actor: string,
): Parameters<typeof connect>[0]["collab"] {
  if (collab.kind !== "fluid" || collab.relay !== "azure") {
    return collab;
  }
  return {
    ...collab,
    tokenProvider: httpTokenProvider(`/api/fluid/token?as=${encodeURIComponent(actor)}`),
  };
}

function mount(
  root: Element,
  board: WebCollab & { typeName: string },
  actor: string,
  currentWsId: string,
  boardList: BoardSummary[],
): void {
  const isC4 = board.typeName === "c4-architecture";

  // The switcher lists every live board, not one per schema, so it shows the
  // names people gave them rather than the two type titles.
  const wsOptions = boardList
    .map(
      (ws) =>
        `<option value="${escapeHtml(ws.id)}" ${ws.id === currentWsId ? "selected" : ""}>
          ${escapeHtml(ws.emoji)} ${escapeHtml(ws.name)}
        </option>`,
    )
    .join("");

  const current = boardList.find((ws) => ws.id === currentWsId);
  const headerTitle = current?.name ?? (isC4 ? t.header.c4Title : t.header.voiceTitle);
  const headerSubtitle = isC4 ? t.header.c4Subtitle : t.header.voiceSubtitle;
  document.title = `${headerTitle} — collabnode`;

  const voiceSuggestions = (isC4 ? t.stage.c4Suggestions : t.stage.voiceSuggestions)
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");

  root.innerHTML = `
    <header class="topbar">
      <div>
        <a class="crumb" href="${escapeHtml(homeHref())}">${escapeHtml(t.home.backToBoards)}</a>
        <h1>${escapeHtml(headerTitle)}</h1>
        <p class="sub">${escapeHtml(headerSubtitle)}</p>
      </div>
      <div class="topbar-right">
        <select class="ws-select" data-ws-select title="${escapeHtml(t.header.switchWorkspace)}">
          ${wsOptions}
        </select>
        <div class="who" title="${escapeHtml(t.header.signedInAs(actor))}">${escapeHtml(initials(actor))}</div>
      </div>
    </header>

    <section class="stage" aria-label="${escapeHtml(t.stage.aria)}">
      <button type="button" class="mic" data-talk disabled aria-pressed="false">
        <span class="mic-ring" data-ring aria-hidden="true"></span>
        <svg class="mic-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" fill="none" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span class="mic-label" data-mic-label>${escapeHtml(t.stage.tapToTalk)}</span>
      </button>
      <p class="state" data-state role="status" aria-live="polite">${escapeHtml(t.stage.gettingReady)}</p>
      <ul class="suggestions" data-suggestions>
        ${voiceSuggestions}
      </ul>
      <ol class="transcript" data-chat aria-live="polite" aria-label="${escapeHtml(t.stage.conversationAria)}"></ol>
    </section>

    ${
      isC4
        ? `
        <!-- C4 Architecture View -->
        <section class="board-section" aria-label="${escapeHtml(t.c4.aria)}">
          <div class="board-head">
            <div class="tabs" role="tablist">
              <button type="button" class="tab-btn active" data-c4-tab="all" role="tab">
                📦 ${escapeHtml(t.c4.allElements)} <span class="tab-count" data-c4-count-all>0</span>
              </button>
              <button type="button" class="tab-btn" data-c4-tab="systems" role="tab">
                🏢 ${escapeHtml(t.c4.systemsAndPeople)} <span class="tab-count" data-c4-count-sys>0</span>
              </button>
              <button type="button" class="tab-btn" data-c4-tab="containers" role="tab">
                🚢 ${escapeHtml(t.c4.containers)} <span class="tab-count" data-c4-count-containers>0</span>
              </button>
              <button type="button" class="tab-btn" data-c4-tab="components" role="tab">
                🧩 ${escapeHtml(t.c4.components)} <span class="tab-count" data-c4-count-components>0</span>
              </button>
            </div>
            <button type="button" class="link" data-new-c4>${escapeHtml(t.c4.addElement)}</button>
          </div>
          <div class="c4-grid" data-c4-grid></div>
        </section>
        `
        : `
        <!-- Voice Board (Notes & Tasks & People) View -->
        <section class="board-section" aria-label="${escapeHtml(t.board.aria)}">
          <div class="board-head">
            <div class="tabs" role="tablist">
              <button type="button" class="tab-btn active" data-tab="notes" role="tab" aria-selected="true">
                📝 ${escapeHtml(t.board.notes)} <span class="tab-count" data-notes-count>0</span>
              </button>
              <button type="button" class="tab-btn" data-tab="tasks" role="tab" aria-selected="false">
                ✅ ${escapeHtml(t.board.tasks)} <span class="tab-count" data-tasks-count>0</span>
              </button>
              <button type="button" class="tab-btn" data-tab="people" role="tab" aria-selected="false">
                👥 ${escapeHtml(t.board.people)} <span class="tab-count" data-people-count>0</span>
              </button>
            </div>
            <button type="button" class="link" data-back hidden>${escapeHtml(t.board.allNotes)}</button>
          </div>

          <div class="tab-pane" data-pane="notes">
            <div class="cards" data-list></div>
            <div class="detail" data-detail hidden>
              <div class="cm-host" data-editor></div>
            </div>
          </div>

          <div class="tab-pane" data-pane="tasks" hidden>
            <div class="tasks-list" data-tasks-list></div>
          </div>

          <div class="tab-pane" data-pane="people" hidden>
            <div class="people-grid" data-people-grid></div>
          </div>
        </section>
        `

    }

    <details class="dev" data-dev>
      <summary>${escapeHtml(t.dev.summary)}</summary>
      <div class="dev-body">
        <p class="dev-line" data-dev-status>${escapeHtml(t.dev.checking)}</p>
        <p class="dev-caption">${escapeHtml(t.dev.graphCaption)}</p>
        <collab-graph toolbar="false" inspector="false" editable="false"></collab-graph>
        <p class="dev-caption">${escapeHtml(t.dev.toolCallsCaption)}</p>
        <ol class="dev-log" data-dev-log aria-label="${escapeHtml(t.dev.toolCallsAria)}"></ol>
      </div>
    </details>
  `;

  // Workspace Switcher listener
  const wsSelect = root.querySelector<HTMLSelectElement>("[data-ws-select]");
  if (wsSelect) {
    wsSelect.addEventListener("change", () => {
      const selectedId = wsSelect.value;
      const url = new URL(location.href);
      url.searchParams.set("workspace", selectedId);
      url.searchParams.set("lang", lang);
      location.href = url.toString();
    });
  }

  // Developer graph drawer mount
  const graph = root.querySelector("collab-graph");
  const dev = root.querySelector<HTMLDetailsElement>("[data-dev]");
  if (!(graph instanceof CollabGraph) || !dev) {
    throw new Error("failed to mount graph");
  }
  let graphMounted = false;
  dev.addEventListener("toggle", () => {
    if (dev.open && !graphMounted) {
      graphMounted = true;
      graph.session = board.session;
    }
  });

  if (isC4) {
    mountC4View(root, board);
  } else {
    mountNotesAndTasksView(root, board, actor);
  }

  mountVoice(root, currentWsId);
}

function mountC4View(root: Element, board: WebCollab): void {
  const grid = root.querySelector<HTMLElement>("[data-c4-grid]");
  const countAll = root.querySelector<HTMLElement>("[data-c4-count-all]");
  const countSys = root.querySelector<HTMLElement>("[data-c4-count-sys]");
  const countContainers = root.querySelector<HTMLElement>("[data-c4-count-containers]");
  const countComponents = root.querySelector<HTMLElement>("[data-c4-count-components]");
  const c4TabBtns = root.querySelectorAll<HTMLButtonElement>("[data-c4-tab]");
  const addBtn = root.querySelector<HTMLButtonElement>("[data-new-c4]");

  if (!grid || !countAll || !countSys || !countContainers || !countComponents) {
    return;
  }

  let activeFilter: "all" | "systems" | "containers" | "components" = "all";

  const renderC4 = (): void => {
    const snapshot = board.session.snapshot();
    const allNodes = snapshot.nodes;
    const systemsAndPeople = allNodes.filter((n) => n.type === "SoftwareSystem" || n.type === "Person");
    const containers = allNodes.filter((n) => n.type === "Container");
    const components = allNodes.filter((n) => n.type === "Component");

    countAll.textContent = String(allNodes.length);
    countSys.textContent = String(systemsAndPeople.length);
    countContainers.textContent = String(containers.length);
    countComponents.textContent = String(components.length);

    let displayNodes = allNodes;
    if (activeFilter === "systems") displayNodes = systemsAndPeople;
    if (activeFilter === "containers") displayNodes = containers;
    if (activeFilter === "components") displayNodes = components;

    const cards = displayNodes
      .map((node) => {
        const name = escapeHtml(String(node.properties.name ?? t.c4.unnamed));
        const desc = escapeHtml(String(node.properties.description ?? node.properties.role ?? ""));
        const tech = node.properties.technology ? escapeHtml(String(node.properties.technology)) : "";
        const type = node.type;

        // Collect relationships
        const outgoingUses = snapshot.edges
          .filter((e) => e.type === "USES" && e.from === node.id)
          .map((e) => {
            const target = snapshot.nodes.find((n) => n.id === e.to);
            return `<div class="rel-item"><span class="rel-tag">${escapeHtml(t.c4.uses)}</span> ${escapeHtml(String(target?.properties.name ?? t.c4.node))}</div>`;
          });

        const contains = snapshot.edges
          .filter((e) => e.type === "CONTAINS" && e.from === node.id)
          .map((e) => {
            const target = snapshot.nodes.find((n) => n.id === e.to);
            return `<div class="rel-item"><span class="rel-tag">${escapeHtml(t.c4.contains)}</span> ${escapeHtml(String(target?.properties.name ?? t.c4.node))}</div>`;
          });

        const relsHtml = [...outgoingUses, ...contains].join("");

        return `
          <div class="c4-card" data-c4-id="${escapeHtml(node.id)}">
            <div class="c4-card-head">
              <h3 class="c4-card-title">${name}</h3>
              <span class="c4-type-badge c4-type-${escapeHtml(type)}">${escapeHtml(type)}</span>
            </div>
            ${tech ? `<span class="tech-pill">${tech}</span>` : ""}
            ${desc ? `<p class="c4-card-desc">${desc}</p>` : ""}
            ${relsHtml ? `<div class="c4-card-rels">${relsHtml}</div>` : ""}
          </div>
        `;
      })
      .join("");

    grid.innerHTML = cards || `<p class="sub">${escapeHtml(t.c4.empty)}</p>`;
  };

  c4TabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      c4TabBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      activeFilter = btn.dataset.c4Tab as any;
      renderC4();
    });
  });

  if (addBtn) {
    addBtn.addEventListener("click", () => {
      const type = window.prompt(t.c4.typePrompt, "Container")?.trim();
      if (!type || !["SoftwareSystem", "Container", "Component", "Person"].includes(type)) return;
      const name = window.prompt(t.c4.namePrompt)?.trim();
      if (!name) return;
      const description = window.prompt(t.c4.descriptionPrompt, "")?.trim() ?? "";
      const technology = ["Container", "Component"].includes(type)
        ? (window.prompt(t.c4.technologyPrompt, "TypeScript")?.trim() ?? "")
        : undefined;

      void (async () => {
        const nodeId = await board.session.upsertNode({
          type,
          properties: {
            name,
            description: description || undefined,
            technology: technology || undefined,
          },
        });

        const snapshot = board.session.snapshot();
        // If container, nest inside existing SoftwareSystem if one exists
        if (type === "Container") {
          const sysNode = snapshot.nodes.find((n) => n.type === "SoftwareSystem");
          if (sysNode) {
            await board.session.upsertEdge({
              type: "CONTAINS",
              from: sysNode.id,
              to: nodeId,
            });
          }
        } else if (type === "Component") {
          const containerNode = snapshot.nodes.find((n) => n.type === "Container");
          if (containerNode) {
            await board.session.upsertEdge({
              type: "CONTAINS",
              from: containerNode.id,
              to: nodeId,
            });
          }
        }
      })();
    });
  }

  board.session.onChange(renderC4);
  renderC4();
}

function mountNotesAndTasksView(root: Element, board: WebCollab, actor: string): void {
  const host = root.querySelector<HTMLElement>("[data-editor]");
  const list = root.querySelector<HTMLElement>("[data-list]");
  const detail = root.querySelector<HTMLElement>("[data-detail]");
  const back = root.querySelector<HTMLButtonElement>("[data-back]");
  const tasksList = root.querySelector<HTMLElement>("[data-tasks-list]");
  const peopleGrid = root.querySelector<HTMLElement>("[data-people-grid]");
  const notesCount = root.querySelector<HTMLElement>("[data-notes-count]");
  const tasksCount = root.querySelector<HTMLElement>("[data-tasks-count]");
  const peopleCount = root.querySelector<HTMLElement>("[data-people-count]");
  const tabBtns = root.querySelectorAll<HTMLButtonElement>("[data-tab]");
  const tabPanes = root.querySelectorAll<HTMLElement>("[data-pane]");


  if (!host || !list || !detail || !back || !tasksList || !peopleGrid || !notesCount || !tasksCount || !peopleCount) {
    return;
  }

  let activeTab: "notes" | "tasks" | "people" = "notes";
  let binding: { destroy(): void } | undefined;
  let boundId: string | undefined;

  const setTab = (tab: "notes" | "tasks" | "people"): void => {
    activeTab = tab;
    tabBtns.forEach((btn) => {
      const isCurrent = btn.dataset.tab === tab;
      btn.classList.toggle("active", isCurrent);
      btn.setAttribute("aria-selected", isCurrent ? "true" : "false");
    });
    tabPanes.forEach((pane) => {
      pane.hidden = pane.dataset.pane !== tab;
    });
    if (tab === "notes") {
      showGrid();
    } else if (tab === "tasks") {
      back.hidden = true;
      renderTasks();
    } else if (tab === "people") {
      back.hidden = true;
      renderPeople();
    }
  };

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab as "notes" | "tasks" | "people";
      if (tab) setTab(tab);
    });
  });

  const showGrid = (): void => {
    binding?.destroy();
    binding = undefined;
    boundId = undefined;
    host.replaceChildren();
    detail.hidden = true;
    list.hidden = false;
    back.hidden = true;
    renderNotes();
  };

  const openNote = (id: string | undefined): void => {
    if (!id || id === boundId) {
      return;
    }
    const node = board.session.snapshot().nodes.find((item) => item.id === id);
    if (!node || node.type !== "Note") {
      return;
    }
    binding?.destroy();
    binding = undefined;
    host.replaceChildren();
    boundId = id;
    list.hidden = true;
    detail.hidden = false;
    back.hidden = false;
    void board.session
      .ensureCollab(id, "Note")
      .then(() => {
        if (boundId !== id) {
          return;
        }
        binding = bindCollabText(host, board.session.collabText(id, "body"));
      });
  };

  const renderNotes = (): void => {
    const snapshot = board.session.snapshot();
    const notes = snapshot.nodes.filter((node) => node.type === "Note");
    notesCount.textContent = String(notes.length);

    const cards = notes
      .map((note) => {
        const title = escapeHtml(String(note.properties.title ?? t.board.untitled));
        const preview = escapeHtml(excerpt(String(note.properties.body ?? "")));
        return `<button type="button" class="card" data-id="${escapeHtml(note.id)}">
          <span class="card-title">${title}</span>
          <span class="card-preview">${preview || escapeHtml(t.board.emptyNote)}</span>
        </button>`;
      })
      .join("");
    list.innerHTML = `${cards}<button type="button" class="card new" data-new-note>
      <span class="card-plus" aria-hidden="true">+</span>
      <span class="card-title">${escapeHtml(t.board.newNote)}</span>
    </button>`;
  };

  const renderTasks = (): void => {
    const snapshot = board.session.snapshot();
    const tasks = snapshot.nodes.filter((node) => node.type === "Task");
    const persons = new Map(snapshot.nodes.filter((n) => n.type === "Person").map((p) => [p.id, String(p.properties.name ?? "")]));
    const notes = new Map(snapshot.nodes.filter((n) => n.type === "Note").map((n) => [n.id, String(n.properties.title ?? "")]));

    tasksCount.textContent = String(tasks.length);

    const rows = tasks
      .map((task) => {
        const title = escapeHtml(String(task.properties.title ?? t.board.untitledTask));
        const status = String(task.properties.status ?? "todo").toLowerCase();
        const priority = String(task.properties.priority ?? "medium").toLowerCase();
        const isDone = status === "done";

        const assignEdge = snapshot.edges.find((e) => e.type === "ASSIGNED_TO" && e.from === task.id);
        const assignee = assignEdge ? persons.get(assignEdge.to) : undefined;

        const noteEdge = snapshot.edges.find((e) => e.type === "PRODUCES_TASK" && e.to === task.id);
        const sourceNote = noteEdge ? notes.get(noteEdge.from) : undefined;

        return `
          <div class="task-row ${isDone ? "done" : ""}" data-task-id="${escapeHtml(task.id)}">
            <button type="button" class="task-check ${isDone ? "checked" : ""}" data-toggle-task="${escapeHtml(task.id)}" title="${escapeHtml(t.board.toggleCompletion)}">
              ${isDone ? "✓" : ""}
            </button>
            <div class="task-body">
              <span class="task-title">${title}</span>
              <div class="task-meta">
                <button type="button" class="badge badge-status-${escapeHtml(status)}" data-cycle-status="${escapeHtml(task.id)}" title="${escapeHtml(t.board.changeStatus)}">
                  ${escapeHtml(statusLabel(status))}
                </button>
                <span class="badge badge-priority-${escapeHtml(priority)}">${escapeHtml(priorityLabel(priority))}</span>
                ${assignee ? `<span class="chip-author">👤 ${escapeHtml(assignee)}</span>` : ""}
                ${sourceNote ? `<span class="chip-note" title="${escapeHtml(t.board.fromNote)}">📄 ${escapeHtml(sourceNote)}</span>` : ""}
              </div>
            </div>
          </div>
        `;
      })
      .join("");

    tasksList.innerHTML = `
      ${rows}
      <button type="button" class="new-task-btn" data-new-task>
        <span>+</span> ${escapeHtml(t.board.addTask)}
      </button>
    `;
  };

  const renderPeople = (): void => {
    const snapshot = board.session.snapshot();
    const people = snapshot.nodes.filter((node) => node.type === "Person");
    const tasks = snapshot.nodes.filter((node) => node.type === "Task");
    peopleCount.textContent = String(people.length);

    const cards = people
      .map((person) => {
        const name = escapeHtml(String(person.properties.name ?? t.board.unnamed));
        const authoredCount = snapshot.edges.filter((e) => e.type === "AUTHORED" && e.from === person.id).length;
        const assignedTasks = snapshot.edges
          .filter((e) => e.type === "ASSIGNED_TO" && e.to === person.id)
          .map((e) => tasks.find((t) => t.id === e.from))
          .filter((t): t is NonNullable<typeof t> => Boolean(t));

        const tasksPreview = assignedTasks
          .slice(0, 3)
          .map((task) => `<div class="person-task-chip">✓ ${escapeHtml(String(task.properties.title ?? t.board.taskFallback))}</div>`)
          .join("");

        return `
          <div class="person-card" data-person-id="${escapeHtml(person.id)}">
            <div class="person-card-head">
              <div class="person-avatar">${escapeHtml(initials(String(person.properties.name)))}</div>
              <div class="person-info">
                <h3 class="person-name">${name}</h3>
                <div class="person-stats">
                  <span class="person-stat-pill">📄 ${escapeHtml(t.board.noteCount(authoredCount))}</span>
                  <span class="person-stat-pill">✅ ${escapeHtml(t.board.taskCount(assignedTasks.length))}</span>
                </div>
              </div>
              <button type="button" class="person-del-btn" data-delete-person="${escapeHtml(person.id)}" title="${escapeHtml(t.board.removePerson(String(person.properties.name ?? t.board.unnamed)))}">
                🗑️
              </button>
            </div>
            ${tasksPreview ? `<div class="person-tasks-preview">${tasksPreview}</div>` : ""}
          </div>
        `;
      })
      .join("");

    peopleGrid.innerHTML = `
      ${cards}
      <button type="button" class="person-card new" data-new-person>
        <span style="font-size: 24px; font-weight: 300;">+</span>
        <span style="font-weight: 600;">${escapeHtml(t.board.addPerson)}</span>
      </button>
    `;
  };

  list.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-new-note]")) {
      const title = window.prompt(t.board.newNotePrompt)?.trim();
      if (title) {
        void board.session
          .upsertNode({ type: "Note", properties: { title, body: "" } })
          .then((id) => openNote(id));
      }
      return;
    }
    const card = target.closest("button[data-id]");
    if (card instanceof HTMLButtonElement) {
      openNote(card.dataset.id);
    }
  });

  tasksList.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const toggleBtn = target.closest<HTMLButtonElement>("[data-toggle-task]");
    if (toggleBtn) {
      const taskId = toggleBtn.dataset.toggleTask;
      const task = board.session.snapshot().nodes.find((n) => n.id === taskId);
      if (task) {
        const current = String(task.properties.status ?? "todo");
        const next = current === "done" ? "todo" : "done";
        void board.session.upsertNode({
          id: taskId,
          type: "Task",
          properties: { ...task.properties, status: next },
        });
      }
      return;
    }

    const cycleBtn = target.closest<HTMLButtonElement>("[data-cycle-status]");
    if (cycleBtn) {
      const taskId = cycleBtn.dataset.cycleStatus;
      const task = board.session.snapshot().nodes.find((n) => n.id === taskId);
      if (task) {
        const current = String(task.properties.status ?? "todo");
        const next = current === "todo" ? "doing" : current === "doing" ? "done" : "todo";
        void board.session.upsertNode({
          id: taskId,
          type: "Task",
          properties: { ...task.properties, status: next },
        });
      }
      return;
    }

    if (target.closest("[data-new-task]")) {
      const title = window.prompt(t.board.taskTitlePrompt)?.trim();
      if (!title) return;
      const priorityPrompt = window.prompt(t.board.priorityPrompt, "medium")?.trim().toLowerCase();
      const priority = ["low", "medium", "high"].includes(priorityPrompt ?? "") ? priorityPrompt : "medium";

      void (async () => {
        const taskId = await board.session.upsertNode({
          type: "Task",
          properties: { title, status: "todo", priority },
        });
        const personNode = board.session.snapshot().nodes.find(
          (n) => n.type === "Person" && String(n.properties.name).toLowerCase() === actor.toLowerCase(),
        );
        if (personNode) {
          await board.session.upsertEdge({
            type: "ASSIGNED_TO",
            from: taskId,
            to: personNode.id,
          });
        }
      })();
    }
  });

  peopleGrid.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const delBtn = target.closest<HTMLButtonElement>("[data-delete-person]");
    if (delBtn) {
      const personId = delBtn.dataset.deletePerson;
      const snapshot = board.session.snapshot();
      const person = snapshot.nodes.find((n) => n.id === personId);
      if (!person) return;
      const name = String(person.properties.name ?? t.board.unnamed);
      if (window.confirm(t.board.confirmRemovePerson(name))) {
        void (async () => {
          const connectedEdges = snapshot.edges.filter((e) => e.from === personId || e.to === personId);
          for (const edge of connectedEdges) {
            await board.session.deleteEdge(edge.id);
          }
          await board.session.deleteNode(personId!);
        })();
      }
      return;
    }

    if (target.closest("[data-new-person]")) {
      const name = window.prompt(t.board.personNamePrompt)?.trim();
      if (!name) return;
      void board.session.upsertNode({
        type: "Person",
        properties: { name },
      });
    }
  });

  back.addEventListener("click", showGrid);

  board.session.onChange(() => {
    const snapshot = board.session.snapshot();
    notesCount.textContent = String(snapshot.nodes.filter((n) => n.type === "Note").length);
    tasksCount.textContent = String(snapshot.nodes.filter((n) => n.type === "Task").length);
    peopleCount.textContent = String(snapshot.nodes.filter((n) => n.type === "Person").length);

    if (activeTab === "notes") {
      if (!boundId) {
        renderNotes();
      }
    } else if (activeTab === "tasks") {
      renderTasks();
    } else if (activeTab === "people") {
      renderPeople();
    }
  });

  renderNotes();
  renderTasks();
  renderPeople();

}

function mountVoice(root: Element, wsId: string): void {
  const state = root.querySelector<HTMLElement>("[data-state]");
  const chat = root.querySelector<HTMLOListElement>("[data-chat]");
  const talk = root.querySelector<HTMLButtonElement>("[data-talk]");
  const micLabel = root.querySelector<HTMLElement>("[data-mic-label]");
  const ring = root.querySelector<HTMLElement>("[data-ring]");
  const devStatus = root.querySelector<HTMLElement>("[data-dev-status]");
  const devLog = root.querySelector<HTMLOListElement>("[data-dev-log]");
  if (!state || !chat || !talk || !micLabel || !ring || !devStatus || !devLog) {
    return;
  }

  let handle: VoiceHandle | undefined;
  let ready = false;
  let setupHelp = "";

  const CAPTION: Record<VoiceState, string> = t.caption;

  const setState = (next: VoiceState, detail?: string): void => {
    state.textContent = next === "error" && detail ? detail : CAPTION[next];
    state.dataset.value = next;
    talk.dataset.value = next;
    talk.setAttribute("aria-pressed", handle ? "true" : "false");
    micLabel.textContent = handle ? t.stage.tapToStop : t.stage.tapToTalk;
    if (!handle) {
      ring.style.setProperty("--level", "0");
    }
  };

  const live = new Map<string, HTMLLIElement>();
  const say = (role: "user" | "agent" | "note", text: string, key?: string): void => {
    const id = key ?? `${role}:${Date.now()}:${Math.random()}`;
    let item = live.get(id);
    if (!item) {
      item = document.createElement("li");
      item.className = role;
      chat.append(item);
      live.set(id, item);
    }
    const who = role === "user" ? t.speaker.you : role === "agent" ? t.speaker.agent : "";
    item.innerHTML = who
      ? `<span class="who-label">${who}</span><p>${escapeHtml(text)}</p>`
      : `<p class="did">${escapeHtml(text)}</p>`;
    chat.scrollTop = chat.scrollHeight;
  };

  talk.addEventListener("click", () => {
    if (handle) {
      const current = handle;
      handle = undefined;
      void current.stop().finally(() => setState("idle"));
      return;
    }
    if (!ready) {
      say("note", setupHelp || t.voice.notSetUp);
      return;
    }
    talk.disabled = true;
    setState("connecting");
    void startVoice(
      {
        onState: (next, detail) => setState(next, detail),
        onPartial: (role, id, text) => say(role, text, `${role}:${id}`),
        onFinal: (role, id, text) => say(role, text, `${role}:${id}`),
        onLevel: (level) => ring.style.setProperty("--level", level.toFixed(3)),
      },
      { workspaceId: wsId, language: lang },
    )

      .then((started) => {
        handle = started;
        setState("listening");
      })
      .catch((error: unknown) => {
        handle = undefined;
        setState("error", micError(error));
        say("note", micError(error));
      })
      .finally(() => {
        talk.disabled = false;
        micLabel.textContent = handle ? t.stage.tapToStop : t.stage.tapToTalk;
      });
  });

  const events = new EventSource("/api/voice/log");
  events.onmessage = (event) => {
    const entry = JSON.parse(event.data) as { kind: string; text: string; tool?: string };
    const line = document.createElement("li");
    line.textContent = entry.text;
    devLog.append(line);
    if (entry.kind === "tool" && entry.tool) {
      say("note", describeTool(entry.tool, entry.text));
    } else if (entry.kind === "error") {
      say("note", t.voice.writeFailed);
    }
  };

  void fetch(`/api/voice/status?workspace=${encodeURIComponent(wsId)}&lang=${lang}`)
    .then(async (response) => {
      const body = (await response.json()) as {
        ready: boolean;
        model?: string;
        voice?: string;
        tools?: string[];
        mcp?: string;
        typeName?: string;
      };
      ready = body.ready;
      talk.disabled = !ready;
      devStatus.textContent = ready
        ? t.dev.ready(body.model ?? "", body.voice ?? "", body.tools?.length ?? 0, body.mcp ?? "/mcp")
        : t.dev.notConfigured;
      if (ready) {
        setState("idle");
      } else {
        setupHelp = t.voice.needsKeys;
        state.textContent = setupHelp;
        state.dataset.value = "error";
      }
    })
    .catch(() => {
      setupHelp = t.voice.unreachable;
      state.textContent = setupHelp;
      state.dataset.value = "error";
    });

  setState("idle");
  state.textContent = t.stage.gettingReady;
}
