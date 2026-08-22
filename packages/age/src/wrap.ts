import { assertGraphName, assertIdent } from "./names.js";

export interface WrappedCypher {
  sql: string;
  values: unknown[];
}

function dollarQuote(cypher: string): string {
  if (!cypher.includes("$$")) {
    return `$$${cypher}$$`;
  }
  let tag = "cn";
  let n = 0;
  while (cypher.includes(`$${tag}$`)) {
    tag = `cn${n}`;
    n += 1;
  }
  return `$${tag}$${cypher}$${tag}$`;
}

function lastReturnChunk(cypher: string): string | undefined {
  const re = /\bRETURN\b/gi;
  let last: number | undefined;
  let match = re.exec(cypher);
  while (match) {
    last = match.index + match[0].length;
    match = re.exec(cypher);
  }
  if (last === undefined) {
    return undefined;
  }
  const rest = cypher.slice(last);
  const stop = /\b(?:ORDER\s+BY|SKIP|LIMIT|UNION)\b/i.exec(rest);
  return (stop ? rest.slice(0, stop.index) : rest).trim();
}

function splitTopLevel(list: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i]!;
    if (quote) {
      current += ch;
      if (ch === quote && list[i - 1] !== "\\") {
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth += 1;
      current += ch;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      current += ch;
      continue;
    }
    if (ch === "," && depth === 0) {
      if (current.trim()) {
        items.push(current.trim());
      }
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    items.push(current.trim());
  }
  return items;
}

function uniqueName(base: string, used: Set<string>, index: number): string {
  let name = base || `col${index}`;
  if (!/^[A-Za-z_]/.test(name)) {
    name = `col${index}`;
  }
  if (!used.has(name)) {
    return name;
  }
  let n = 2;
  while (used.has(`${name}_${n}`)) {
    n += 1;
  }
  return `${name}_${n}`;
}

function itemAlias(item: string, index: number): string {
  const trimmed = item.trim().replace(/^DISTINCT\s+/i, "");
  const asMatch = /\sAS\s+([a-z_][a-z0-9_]*)$/i.exec(trimmed);
  if (asMatch) {
    return asMatch[1]!;
  }
  const ident = trimmed.replaceAll(".", "_").replaceAll(/[^A-Za-z0-9_]/g, "");
  return ident || `col${index}`;
}

/** Column names for AGE `AS (col agtype, ...)` from a Cypher RETURN list. */
export function returnColumns(cypher: string): string[] {
  const chunk = lastReturnChunk(cypher);
  if (!chunk) {
    return ["v"];
  }
  const items = splitTopLevel(chunk);
  if (items.length === 0) {
    return ["v"];
  }
  const used = new Set<string>();
  return items.map((item, index) => {
    const name = uniqueName(itemAlias(item, index), used, index);
    used.add(name);
    return assertIdent(name);
  });
}

export function wrapCypher(
  graphName: string,
  cypher: string,
  params?: Record<string, unknown>,
): WrappedCypher {
  const graph = assertGraphName(graphName);
  const columns = returnColumns(cypher);
  const asClause = columns.map((name) => `${name} agtype`).join(", ");
  const quoted = dollarQuote(cypher);
  if (params && Object.keys(params).length > 0) {
    return {
      sql: `SELECT * FROM cypher('${graph}', ${quoted}, $1::agtype) AS (${asClause})`,
      values: [JSON.stringify(params)],
    };
  }
  return {
    sql: `SELECT * FROM cypher('${graph}', ${quoted}) AS (${asClause})`,
    values: [],
  };
}
