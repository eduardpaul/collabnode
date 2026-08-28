export interface C4Element {
  title: string;
  level: "context" | "container" | "component";
  markdown: string;
}

/** Person / actor: `User([Browser])` */
const PERSON_RE = /\b[A-Za-z][\w]*\(\[([^\]]+)\]\)/g;
/** Database cylinder: `Redis[(Registry)]` */
const DATABASE_RE = /\b[A-Za-z][\w]*\[\(([^\]]+)\)\]/g;
/** Rectangle: `UI[React Frontend]` — matched after the other two. */
const BOX_RE = /\b[A-Za-z][\w]*\[([^\]]+)\]/g;

function cleanLabel(raw: string): string {
  return raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function extractC4Boxes(markdown: string): { containers: string[]; persons: string[] } {
  const containers: string[] = [];
  const persons: string[] = [];
  const seen = new Set<string>();
  const add = (list: string[], raw: string) => {
    const title = cleanLabel(raw);
    const key = title.toLowerCase();
    if (!title || seen.has(key)) return;
    seen.add(key);
    list.push(title);
  };

  let match: RegExpExecArray | null;
  const personRe = new RegExp(PERSON_RE.source, "g");
  while ((match = personRe.exec(markdown))) {
    add(persons, match[1] ?? "");
  }
  const dbRe = new RegExp(DATABASE_RE.source, "g");
  while ((match = dbRe.exec(markdown))) {
    add(containers, match[1] ?? "");
  }
  const stripped = markdown.replace(new RegExp(PERSON_RE.source, "g"), " ").replace(new RegExp(DATABASE_RE.source, "g"), " ");
  const boxRe = new RegExp(BOX_RE.source, "g");
  while ((match = boxRe.exec(stripped))) {
    add(containers, match[1] ?? "");
  }
  return { containers, persons };
}

export function isCombinedC4Diagram(markdown: string): boolean {
  return extractC4Boxes(markdown).containers.length >= 2;
}

/** One C4Model node = one element. Split mermaid dumps that pack several containers. */
export function expandCombinedC4Models(models: C4Element[]): C4Element[] {
  const out: C4Element[] = [];
  const seen = new Set<string>();
  const push = (el: C4Element) => {
    const key = `${el.level}:${el.title.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(el);
  };

  for (const model of models) {
    const { containers } = extractC4Boxes(model.markdown);
    if (containers.length < 2) {
      push(model);
      continue;
    }
    if (model.level === "context") {
      push({
        title: model.title,
        level: "context",
        markdown: `System boundary. Containers: ${containers.join(", ")}.`,
      });
    }
    for (const title of containers) {
      push({
        title,
        level: "container",
        markdown: `${title} container.`,
      });
    }
  }
  return out;
}

export interface C4PlanElement {
  type: string;
  title: string;
  description: string;
  [key: string]: unknown;
}

/**
 * One C4DiagramElement = one element. A model asked for a C4 model sometimes
 * answers with a whole Mermaid diagram in a single node's `description`; split
 * that into one Container per box before it is written, so the graph never
 * holds a packed node and the write stays a single batch.
 *
 * Spawned containers inherit every other property of the element they came
 * from, so they land where the original would have.
 */
export function splitCombinedC4Plan<T extends C4PlanElement>(elements: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  const push = (element: T) => {
    const key = `${element.type}:${element.title.toLowerCase()}`;
    if (!element.title || seen.has(key)) return;
    seen.add(key);
    out.push(element);
  };

  for (const element of elements) {
    const { containers } = extractC4Boxes(String(element.description ?? ""));
    if (containers.length < 2) {
      push(element);
      continue;
    }

    // A packed Container *is* the first box; anything else (Boundary, System)
    // keeps its own identity and gains the boxes as siblings.
    let spawned = containers;
    if (element.type === "Container") {
      push({ ...element, title: containers[0]!, description: `${containers[0]} container.` });
      spawned = containers.slice(1);
    } else {
      push({ ...element, description: `Groups: ${containers.join(", ")}.` });
    }
    for (const title of spawned) {
      push({ ...element, type: "Container", title, description: `${title} container.` });
    }
  }

  return out;
}

/** Every C4 kind the schema allows, in the order a diagram is read. */
export const C4_LEVELS = ["Person", "System", "Boundary", "Container", "Component"] as const;

/**
 * Which C4 kinds a plan left empty. A model asked for "a C4 model" reliably
 * answers with a container diagram and nothing else — no actor, no external
 * system, no component — which renders as a boundary full of boxes with
 * nothing around it. Naming the gap is what makes it visible in the log
 * instead of looking like the architecture the Architect meant to draw.
 */
export function missingC4Levels(elements: Array<{ type: string }>): string[] {
  const present = new Set(elements.map((el) => el.type));
  return C4_LEVELS.filter((level) => !present.has(level));
}

/**
 * `splitCombinedC4Plan` over the node entries of a plan, keeping every entry's
 * `ref` usable as an edge endpoint. The element a packed entry *was* keeps the
 * original ref — so an edge already pointing at it still lands — and each box
 * unpacked out of it gets its own derived ref.
 */
export function splitCombinedC4PlanNodes<
  T extends { type: string; ref: string; properties: Record<string, unknown> },
>(nodes: T[]): T[] {
  const out: T[] = [];
  const packed: Array<C4PlanElement & { __entry: T }> = [];

  for (const node of nodes) {
    if (node.type !== "C4DiagramElement") {
      out.push(node);
      continue;
    }
    packed.push({
      ...node.properties,
      type: String(node.properties.type ?? ""),
      title: String(node.properties.title ?? ""),
      description: String(node.properties.description ?? ""),
      __entry: node,
    });
  }

  const usedRefs = new Set(nodes.map((node) => node.ref));
  const seenRefs = new Set<string>();
  for (const { __entry, ...properties } of splitCombinedC4Plan(packed)) {
    let ref = __entry.ref;
    if (seenRefs.has(ref)) {
      let index = 2;
      while (usedRefs.has(`${__entry.ref}-${index}`)) index++;
      ref = `${__entry.ref}-${index}`;
      usedRefs.add(ref);
    }
    seenRefs.add(ref);
    out.push({ ...__entry, ref, properties });
  }
  return out;
}
