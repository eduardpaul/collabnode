import { resolveI18nString, type Hub, type WorkspaceType } from "collabnode";

/**
 * The board directory: what turns "two workspaces opened at boot" into "open as
 * many as you like, of either type, from the homepage".
 *
 * Everything here is a thin read over the Hub — `hub.open()` already mints,
 * seeds, and leases a workspace, and `hub.registry` already knows which ones
 * are alive. The one thing the Hub has no opinion about is the *name* a person
 * typed into the create form, because a workspace id has to stay URL- and
 * MCP-path-safe. So names live in a side map here, and the id is a slug of the
 * name rather than the name itself.
 */

/**
 * A Hub workspace — one live board.
 *
 * Not `import type { Workspace } from "collabnode"`: that name is re-exported
 * from `@collabnode/runtime`, where it means a `CollabSession`, and the Hub's
 * `Workspace` (the one with `.session`, `.type`, and `.end()`) is not exported
 * under any name. Reading it back off `hub.open` gets the right type without
 * adding `@collabnode/hub` as a direct dependency of the sample.
 */
export type HubWorkspace = Awaited<ReturnType<Hub["open"]>>;

/** `params:` entries in the workspace YAML, as the create form needs to render them. */
type ParamDef = NonNullable<WorkspaceType["params"]>[string];

/**
 * Per-type glyph for the cards. A type the sample has never seen still gets a
 * card, just a generic one — nothing here is allowed to depend on the two
 * types this example happens to ship.
 */
const TYPE_EMOJI: Record<string, string> = {
  "voice-board": "📋",
  "c4-architecture": "🏗️",
};

const FALLBACK_EMOJI = "🧩";

/** Budget for the name half of a board id, so URLs stay readable. */
const MAX_SLUG_LENGTH = 40;

export interface BoardParamField {
  name: string;
  type: string;
  required: boolean;
  default?: unknown;
  description: string;
}

/** A board type offered on the homepage, with the fields its create form needs. */
export interface BoardTypeSummary {
  typeName: string;
  emoji: string;
  title: string;
  description: string;
  params: BoardParamField[];
}

/** One live board, as a homepage card renders it. */
export interface BoardSummary {
  id: string;
  typeName: string;
  emoji: string;
  /** What the person called this board; the type's display title when they named nothing. */
  name: string;
  typeTitle: string;
  description: string;
  createdAt: string;
  nodes: number;
  edges: number;
  mcp: string;
}

/**
 * Where board names live between replicas.
 *
 * The Hub knows a board's id, type, and params; the *name* someone typed is the
 * one thing it has no place for, because ids have to stay URL- and
 * MCP-path-safe. With a single process a Map is enough. With Redis behind the
 * registry and more than one replica, a Map means the board another replica
 * created shows up under its type's default title instead of its name — so the
 * names go next to the records.
 */
export interface BoardNameStore {
  get(id: string): Promise<string | undefined>;
  set(id: string, name: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface CreateBoardInput {
  typeName: string;
  name?: string;
  params?: Record<string, unknown>;
  actorId?: string;
}

export class UnknownBoardTypeError extends Error {
  constructor(typeName: string) {
    super(`Unknown board type '${typeName}'`);
    this.name = "UnknownBoardTypeError";
  }
}

export class BoardDirectory {
  private readonly hub: Hub;
  private readonly mcpBase: string;
  /** Board id → the name someone typed. Ids are slugs, so the original is kept here. */
  private readonly names = new Map<string, string>();
  /** Shared copy of the same map, when this deployment has more than one replica. */
  private readonly nameStore: BoardNameStore | undefined;

  constructor(hub: Hub, options: { mcpBase?: string; names?: BoardNameStore } = {}) {
    this.hub = hub;
    this.mcpBase = (options.mcpBase ?? "/mcp").replace(/\/$/, "");
    this.nameStore = options.names;
  }

  /** The types the homepage offers, with their `params:` as form fields. */
  types(lang: string): BoardTypeSummary[] {
    return this.hub.types().map((type) => ({
      typeName: type.name,
      emoji: TYPE_EMOJI[type.name] ?? FALLBACK_EMOJI,
      title: resolveI18nString(type.schema.config.display?.title, lang) ?? type.name,
      description: resolveI18nString(type.description, lang) ?? "",
      params: paramFields(type.params, lang),
    }));
  }

  /**
   * Opens a new board of `typeName`. The Hub seeds it from the type's
   * `template:` using `params`, so a C4 board created with
   * `systemName: "Payments"` comes up with that system already on the canvas.
   */
  async create(input: CreateBoardInput): Promise<HubWorkspace> {
    const type = this.hub.getType(input.typeName);
    if (!type) {
      throw new UnknownBoardTypeError(input.typeName);
    }
    const name = input.name?.trim() || defaultName(type, "en");
    const id = await this.mintId(type.name, name);
    // `validateParams` inside `hub.open` applies the YAML defaults and rejects
    // the wrong shape, so an empty form still produces a seeded board.
    const ws = await this.hub.open(type.name, {
      id,
      actorId: input.actorId ?? "server",
      params: input.params ?? {},
    });
    this.names.set(ws.id, name);
    await this.nameStore?.set(ws.id, name);
    return ws;
  }

  /**
   * Registers a board opened elsewhere — the two the server seeds at boot —
   * so the homepage lists them under the same names the README uses.
   */
  adopt(ws: HubWorkspace, name?: string): HubWorkspace {
    const resolved = name?.trim() || defaultName(ws.type, "en");
    this.names.set(ws.id, resolved);
    // Deliberately not awaited: adopt() runs inline at boot, and a slow Redis
    // should cost a board its remembered name, not the whole startup.
    void this.nameStore?.set(ws.id, resolved).catch(() => undefined);
    return ws;
  }

  get(id: string): HubWorkspace | undefined {
    const ws = this.hub.getLiveWorkspace(id);
    return ws && ws.state === "active" ? ws : undefined;
  }

  /** Every live board, oldest first, so the seeded pair stays at the top. */
  async list(lang: string): Promise<BoardSummary[]> {
    const records = await this.hub.list({ state: "active" });
    await this.hydrateNames(records.map((record) => record.id));

    const summaries: BoardSummary[] = [];
    for (const record of records) {
      // A board opened on another replica is in the registry but not in this
      // process, and the card needs live node and edge counts. `hub.open()` is
      // idempotent and joins the existing document rather than making a second
      // one, so this is where a replica catches up with its peers.
      let ws = this.hub.getLiveWorkspace(record.id);
      if (!ws) {
        try {
          ws = await this.hub.open(record.typeName, { id: record.id, params: record.params });
        } catch {
          // A board mid-termination, or a type this replica does not define.
          continue;
        }
      }
      summaries.push(this.summarize(ws, lang, record.openedAt));
    }
    return summaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** Pull in names for boards this process has not seen before. */
  private async hydrateNames(ids: string[]): Promise<void> {
    if (!this.nameStore) {
      return;
    }
    const missing = ids.filter((id) => !this.names.has(id));
    await Promise.all(
      missing.map(async (id) => {
        const name = await this.nameStore?.get(id);
        if (name) {
          this.names.set(id, name);
        }
      }),
    );
  }

  summarize(ws: HubWorkspace, lang: string, createdAt = ws.openedAt): BoardSummary {
    const snapshot = ws.session.snapshot();
    return {
      id: ws.id,
      typeName: ws.type.name,
      emoji: TYPE_EMOJI[ws.type.name] ?? FALLBACK_EMOJI,
      name: this.names.get(ws.id) ?? defaultName(ws.type, lang),
      typeTitle: resolveI18nString(ws.type.schema.config.display?.title, lang) ?? ws.type.name,
      description: resolveI18nString(ws.type.description, lang) ?? "",
      createdAt,
      nodes: snapshot.nodes.length,
      edges: snapshot.edges.length,
      mcp: `${this.mcpBase}/w/${ws.id}`,
    };
  }

  /**
   * Ends the board and drops its registry record, so the id is free again.
   * `end()` is the Hub's termination sequence — it drains the projector and
   * builds the artifact first, which is what `retention.onEnd: keep` in the
   * YAML is asking for.
   */
  async remove(id: string): Promise<boolean> {
    const ws = this.hub.getLiveWorkspace(id);
    if (!ws) {
      return false;
    }
    await ws.end("explicit");
    await this.hub.registry.delete(id);
    this.names.delete(id);
    await this.nameStore?.delete(id);
    return true;
  }

  /** The board's id, unique across everything the registry currently knows. */
  private async mintId(typeName: string, name: string): Promise<string> {
    const base = slugId(typeName, name);
    let candidate = base;
    let suffix = 2;
    while (await this.hub.get(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix++;
    }
    return candidate;
  }
}

function defaultName(type: HubWorkspace["type"], lang: string): string {
  return resolveI18nString(type.schema.config.display?.title, lang) ?? type.name;
}

function paramFields(params: Record<string, ParamDef> | undefined, lang: string): BoardParamField[] {
  return Object.entries(params ?? {}).map(([name, def]) => ({
    name,
    type: def.type,
    required: Boolean(def.required),
    default: def.default,
    description: resolveI18nString(def.description, lang) ?? "",
  }));
}

/**
 * `Payments Platform` → `c4-architecture-payments-platform`. The id lands in
 * the page URL and in the MCP mount path, so it stays lowercase ASCII: NFKD
 * splits accented letters into a plain letter plus a combining mark, and
 * splitting on everything that is not `[a-z0-9]` drops the marks along with the
 * punctuation. Truncation happens on a word boundary rather than mid-word, so
 * the id can never end on a stray dash. A name with nothing to slug — all
 * emoji, all Cyrillic — falls back to the bare type name, which `mintId` then
 * makes unique with a counter.
 */
function slugId(typeName: string, name: string): string {
  const words = name.toLowerCase().normalize("NFKD").split(/[^a-z0-9]/).filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > MAX_SLUG_LENGTH) {
      break;
    }
    slug = next;
  }
  // One word longer than the budget: keep a prefix rather than nothing at all.
  if (!slug && words[0]) {
    slug = words[0].slice(0, MAX_SLUG_LENGTH);
  }
  return slug ? `${typeName}-${slug}` : typeName;
}
