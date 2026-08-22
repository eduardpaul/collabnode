import type { GraphEdgeRecord, GraphNodeRecord, GraphSnapshot } from "@collabnode/graph";
import { formatChangeTime, escapeHtml } from "@collabnode/web";
import { isCrdtPropertyType, resolveI18nString, type GraphSchema } from "@collabnode/schema";
import {
  defaultsFor,
  fieldWidget,
  fieldsFor,
  toDatetimeLocal,
  typeGuidelines,
  type FieldDescriptor,
} from "./form.js";
import { humanizeType } from "./edges.js";
import { nodeLabel, typeColor } from "./style.js";

export type GraphMode =
  | { kind: "idle" }
  | { kind: "inspect-node"; id: string }
  | { kind: "inspect-edge"; id: string }
  | { kind: "create-node"; type?: string }
  | { kind: "link-pick" }
  | { kind: "link-from"; fromId: string }
  | { kind: "link-types"; fromId: string; toId: string; types: string[] }
  | { kind: "create-edge"; fromId: string; toId: string; type: string };

export function renderInspector(
  schema: GraphSchema | undefined,
  snapshot: GraphSnapshot | undefined,
  mode: GraphMode,
  editable: boolean,
): string {
  if (!schema) {
    return heading("Inspector", "Connect a session to view this graph.");
  }
  switch (mode.kind) {
    case "idle":
      return heading(
        resolveI18nString(schema.config.display?.title) ?? schema.name,
        editable
          ? "Select a node or edge. Use + Node or Link to edit."
          : "Select a node or edge to inspect it.",
      );
    case "link-pick":
      return heading("Link", "Click the source node, then the target.");
    case "link-from": {
      const node = snapshot?.nodes.find((item) => item.id === mode.fromId);
      const label = node ? nodeLabel(schema, node) : mode.fromId.slice(0, 8);
      return heading("Link", `From “${escapeHtml(label)}”. Click the target node.`);
    }
    case "link-types":
      return renderEdgeTypePicker(schema, snapshot, mode.fromId, mode.toId, mode.types);
    case "create-node":
      if (!mode.type) {
        return renderNodeTypePicker(schema);
      }
      return renderForm({
        heading: `New ${mode.type}`,
        fields: fieldsFor(schema, "node", mode.type),
        values: defaultsFor(fieldsFor(schema, "node", mode.type)),
        guidelines: typeGuidelines(schema, "node", mode.type),
        submitLabel: "Create",
        allowDelete: false,
        editable,
        tagsEnabled: schema.config.tags?.enabled === true,
        tags: [],
      });
    case "create-edge":
      return renderForm({
        heading: `New ${humanizeType(mode.type)}`,
        fields: fieldsFor(schema, "edge", mode.type),
        values: defaultsFor(fieldsFor(schema, "edge", mode.type)),
        guidelines: typeGuidelines(schema, "edge", mode.type),
        submitLabel: "Create",
        allowDelete: false,
        editable,
      });
    case "inspect-node": {
      const node = snapshot?.nodes.find((item) => item.id === mode.id);
      if (!node) {
        return heading("Inspector", "That node is gone.");
      }
      return renderForm({
        heading: nodeLabel(schema, node),
        sub: node.type,
        fields: fieldsFor(schema, "node", node.type, { crdt: "omit" }),
        live: fieldsFor(schema, "node", node.type).filter((field) => isCrdtPropertyType(field.type)),
        values: { ...node.properties },
        guidelines: typeGuidelines(schema, "node", node.type),
        meta: metaLine(node),
        submitLabel: "Save",
        allowDelete: editable,
        editable,
        tagsEnabled: schema.config.tags?.enabled === true,
        tags: node.tags ?? [],
      });
    }
    case "inspect-edge": {
      const edge = snapshot?.edges.find((item) => item.id === mode.id);
      if (!edge) {
        return heading("Inspector", "That edge is gone.");
      }
      return renderForm({
        heading: edgeLabelHeading(schema, snapshot, edge),
        sub: edge.type,
        fields: fieldsFor(schema, "edge", edge.type),
        values: { ...edge.properties },
        guidelines: typeGuidelines(schema, "edge", edge.type),
        meta: metaLine(edge),
        submitLabel: "Save",
        allowDelete: editable,
        editable,
      });
    }
    default:
      return heading("Inspector", "");
  }
}

function heading(title: string, hint: string): string {
  return `<h2>${escapeHtml(title)}</h2><p class="hint">${escapeHtml(hint)}</p>`;
}

function renderNodeTypePicker(schema: GraphSchema): string {
  const types = Object.entries(schema.nodes);
  const buttons = types
    .map(([name, def]) => {
      const color = typeColor(schema, "node", name);
      const desc = resolveI18nString(def.description);
      return `<button type="button" data-pick-node="${escapeHtml(name)}">
        <span class="dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escapeHtml(color)};margin-right:8px"></span>
        ${escapeHtml(name)}
        ${desc ? `<small>${escapeHtml(desc)}</small>` : ""}
      </button>`;
    })
    .join("");
  return `${heading("Add node", "Choose a type from this schema.")}<div class="type-list">${buttons || "<p class='hint'>This schema has no node types.</p>"}</div>`;
}

function renderEdgeTypePicker(
  schema: GraphSchema,
  snapshot: GraphSnapshot | undefined,
  fromId: string,
  toId: string,
  types: string[],
): string {
  const from = snapshot?.nodes.find((node) => node.id === fromId);
  const to = snapshot?.nodes.find((node) => node.id === toId);
  const fromText = from ? nodeLabel(schema, from) : fromId.slice(0, 8);
  const toText = to ? nodeLabel(schema, to) : toId.slice(0, 8);
  const buttons = types
    .map((name) => {
      const label = resolveI18nString(schema.edges[name]?.ui?.label) ?? humanizeType(name);
      return `<button type="button" data-pick-edge="${escapeHtml(name)}">${escapeHtml(label)} <small>${escapeHtml(name)}</small></button>`;
    })
    .join("");
  return `${heading("Link", `“${escapeHtml(fromText)}” → “${escapeHtml(toText)}”`)}<div class="type-list">${buttons}</div>`;
}

function renderForm(input: {
  heading: string;
  sub?: string;
  fields: FieldDescriptor[];
  live?: FieldDescriptor[];
  values: Record<string, unknown>;
  guidelines: string[];
  meta?: string;
  submitLabel: string;
  allowDelete: boolean;
  editable: boolean;
  tagsEnabled?: boolean;
  tags?: string[];
}): string {
  const tagsField =
    input.tagsEnabled === true
      ? `<label>tags<small>Comma-separated. Replaces the whole set. Concurrent edits last-write-win.</small><input type="text" name="_tags" value="${escapeHtml((input.tags ?? []).join(", "))}"${input.editable ? "" : " disabled"}/></label>`
      : "";
  const live = (input.live ?? []).map((field) => liveFieldHtml(field, input.values[field.name])).join("");
  const fields =
    input.fields.map((field) => fieldHtml(field, input.values[field.name])).join("") + live + tagsField;
  const guidelines =
    input.guidelines.length > 0
      ? `<ul class="guidelines">${input.guidelines.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "";
  const meta = input.meta ? `<p class="meta">${escapeHtml(input.meta)}</p>` : "";
  const actions = input.editable
    ? `<div class="inspector-actions">
        ${input.fields.length > 0 || input.tagsEnabled || input.submitLabel === "Create" ? `<button type="submit" class="btn primary">${escapeHtml(input.submitLabel)}</button>` : ""}
        ${input.allowDelete ? `<button type="button" class="btn danger" data-act="delete">Delete</button>` : ""}
        <button type="button" class="btn" data-act="cancel">Cancel</button>
      </div>`
    : "";
  const sub = input.sub ? `<p class="hint">${escapeHtml(input.sub)}</p>` : "";
  if (!input.editable && input.fields.length === 0 && !input.tagsEnabled) {
    return `<h2>${escapeHtml(input.heading)}</h2>${sub}${meta}${guidelines}`;
  }
  return `<h2>${escapeHtml(input.heading)}</h2>${sub}
    <form>
      ${fields || (input.editable ? "" : "<p class='hint'>No properties on this type.</p>")}
      ${actions}
    </form>
    ${meta}${guidelines}`;
}

/** The text an input or textarea should show for a property value. */
function displayText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Same, for fields whose value may be a structure: objects are pretty-printed. */
function displayJson(value: unknown): string {
  if (value === undefined || value === "") {
    return "";
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function liveFieldHtml(field: FieldDescriptor, value: unknown): string {
  const caption = escapeHtml(field.label ?? field.name);
  const hint = `<small>Live ${escapeHtml(field.type)} field. Bind with session.collabText/Map/Array — Save does not write it.</small>`;
  const shown = field.type === "text" ? displayText(value) : displayJson(value);
  return `<label>${caption}${hint}<textarea readonly disabled>${escapeHtml(shown)}</textarea></label>`;
}

function fieldHtml(field: FieldDescriptor, value: unknown): string {
  const required = field.required ? " required" : "";
  const hint = field.description
    ? `<small>${escapeHtml(field.description)}</small>`
    : "";
  const name = escapeHtml(field.name);
  const caption = escapeHtml(field.label ?? field.name);
  const maxLength =
    field.maxLength !== undefined ? ` maxlength="${escapeHtml(String(field.maxLength))}"` : "";
  if (field.derived !== undefined) {
    const shown = displayText(value);
    return `<label>${caption}${hint}<input type="number" value="${escapeHtml(shown)}" step="any" readonly disabled/></label>`;
  }
  switch (fieldWidget(field)) {
    case "hidden": {
      const shown = displayText(value);
      return `<input type="hidden" name="${name}" value="${escapeHtml(shown)}"/>`;
    }
    case "checkbox": {
      const checked = value === true ? " checked" : "";
      return `<label class="check"><input type="checkbox" name="${name}"${checked}${field.required ? " required" : ""}/> ${caption}${hint}</label>`;
    }
    case "enum": {
      const options = (field.values ?? [])
        .map((item) => {
          const selected = String(value ?? field.default ?? "") === item ? " selected" : "";
          return `<option value="${escapeHtml(item)}"${selected}>${escapeHtml(item)}</option>`;
        })
        .join("");
      return `<label>${caption}${hint}<select name="${name}"${required}>${options}</select></label>`;
    }
    case "slider": {
      const numeric = typeof value === "number" && Number.isFinite(value);
      const shown = numeric ? String(value) : String(field.min ?? "");
      const range = `<input type="range" name="${name}" min="${escapeHtml(String(field.min))}" max="${escapeHtml(String(field.max))}" step="1" value="${escapeHtml(shown)}"${required}/>`;
      if (field.required) {
        return `<label class="slider">${caption}${hint}${range}</label>`;
      }
      const checked = numeric ? " checked" : "";
      return `<div class="slider"><span class="field-label">${caption}${hint}</span><div class="slider-row"><label class="check"><input type="checkbox" data-slider-enable${checked}/> Set</label>${range}</div></div>`;
    }
    case "number": {
      const shown = displayText(value);
      const min = field.min !== undefined ? ` min="${escapeHtml(String(field.min))}"` : "";
      const max = field.max !== undefined ? ` max="${escapeHtml(String(field.max))}"` : "";
      const step = field.integer ? "1" : "any";
      return `<label>${caption}${hint}<input type="number" name="${name}" step="${step}" value="${escapeHtml(shown)}"${min}${max}${required}/></label>`;
    }
    case "datetime":
      return `<label>${caption}${hint}<input type="datetime-local" name="${name}" value="${escapeHtml(toDatetimeLocal(value))}"${required}/></label>`;
    case "json": {
      const shown = displayJson(value);
      return `<label>${caption}${hint}<textarea name="${name}"${required}>${escapeHtml(shown)}</textarea></label>`;
    }
    case "textarea": {
      const shown = displayText(value);
      return `<label>${caption}${hint}<textarea name="${name}"${maxLength}${required}>${escapeHtml(shown)}</textarea></label>`;
    }
    default: {
      const shown = displayText(value);
      return `<label>${caption}${hint}<input type="text" name="${name}" value="${escapeHtml(shown)}"${maxLength}${required}/></label>`;
    }
  }
}

function metaLine(record: GraphNodeRecord | GraphEdgeRecord): string | undefined {
  const who = record.meta.updatedBy ?? record.meta.createdBy;
  const at = record.meta.updatedAt ?? record.meta.createdAt;
  if (!who && !at) {
    return undefined;
  }
  const when = at ? formatChangeTime(at) : "";
  return [who, when].filter(Boolean).join(" · ");
}

function edgeLabelHeading(
  schema: GraphSchema,
  snapshot: GraphSnapshot | undefined,
  edge: GraphEdgeRecord,
): string {
  const from = snapshot?.nodes.find((node) => node.id === edge.from);
  const to = snapshot?.nodes.find((node) => node.id === edge.to);
  const fromText = from ? nodeLabel(schema, from) : edge.from.slice(0, 8);
  const toText = to ? nodeLabel(schema, to) : edge.to.slice(0, 8);
  return `${fromText} → ${toText}`;
}

export function readFormValues(form: HTMLFormElement): Record<string, string | boolean> {
  const values: Record<string, string | boolean> = {};
  const data = new FormData(form);
  for (const [key, value] of data.entries()) {
    values[key] = typeof value === "string" ? value : String(value);
  }
  for (const input of form.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
    if (input.name) {
      values[input.name] = input.checked;
    }
  }
  for (const enable of form.querySelectorAll<HTMLInputElement>("input[data-slider-enable]")) {
    const range = enable.closest(".slider")?.querySelector<HTMLInputElement>("input[type=range]");
    if (range?.name && !enable.checked) {
      delete values[range.name];
    }
  }
  return values;
}
