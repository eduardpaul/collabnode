const VALID_GRAPH_NAME = /^[A-Za-z_][A-Za-z0-9_.\-]*[A-Za-z0-9_]$/;
const VALID_LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VALID_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function sanitizeGraphName(raw: string): string {
  let name = raw.trim().replaceAll(/[^A-Za-z0-9_]/g, "_").replaceAll(/_+/g, "_");
  name = name.replace(/^_+/, "").replace(/_+$/, "");
  if (!name) {
    name = "collabnode";
  }
  if (!/^[A-Za-z_]/.test(name)) {
    name = `g_${name}`;
  }
  if (name.length < 3) {
    name = `${name}_g`;
  }
  if (name.length > 63) {
    name = name.slice(0, 63).replace(/_+$/, "");
    if (name.length < 3) {
      name = "collabnode";
    }
  }
  return name;
}

export function assertGraphName(name: string): string {
  const graphName = sanitizeGraphName(name);
  if (graphName.length < 3 || graphName.length > 63 || !VALID_GRAPH_NAME.test(graphName)) {
    throw new Error(
      `Invalid Apache AGE graph name '${name}'. Use 3–63 characters: letter/underscore start, alphanumeric/underscore end.`,
    );
  }
  return graphName;
}

export function assertLabel(name: string): string {
  if (!VALID_LABEL.test(name) || name.length > 63) {
    throw new Error(
      `Invalid Apache AGE label '${name}'. Labels must start with a letter or underscore and contain only letters, digits, and underscores.`,
    );
  }
  return name;
}

export function assertIdent(name: string): string {
  if (!VALID_IDENT.test(name)) {
    throw new Error(`Invalid SQL identifier '${name}'`);
  }
  return name;
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A graph name unique to one workspace.
 *
 * AGE has no row-level tenancy, and `query` passes caller-written Cypher
 * through unchanged - so a `workspace_id` discriminator would be enforced only
 * on the ops collabnode writes, and silently absent from every user query.
 * A graph per workspace is the boundary the engine can actually hold.
 *
 * The suffix is a hash rather than the id itself so the 63-character limit
 * cannot turn two long workspace ids into the same graph.
 */
export function scopedGraphName(base: string, workspaceId: string): string {
  const suffix = shortHash(workspaceId);
  const room = 63 - suffix.length - 1;
  const prefix = trimTrailingUnderscores(sanitizeGraphName(base).slice(0, Math.max(2, room)));
  return assertGraphName(`${prefix}_${suffix}`);
}

/** `/_+$/` backtracks on a long run of underscores; walking back does not. */
function trimTrailingUnderscores(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === "_") {
    end -= 1;
  }
  return value.slice(0, end);
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0");
}
