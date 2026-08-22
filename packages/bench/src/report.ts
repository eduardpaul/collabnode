import type { BenchRow } from "./types.js";

function fmtOps(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "-";
  }
  if (value >= 100) {
    return String(Math.round(value));
  }
  return value.toFixed(1);
}

function fmtMs(value: number): string {
  if (!Number.isFinite(value)) {
    return "-";
  }
  if (value < 0.01) {
    return `${value.toFixed(3)}ms`;
  }
  if (value < 10) {
    return `${value.toFixed(2)}ms`;
  }
  if (value < 1000) {
    return `${value.toFixed(1)}ms`;
  }
  return `${(value / 1000).toFixed(2)}s`;
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

function fmtOk(row: BenchRow): string {
  if (row.ok === undefined) {
    return row.errors === 0 ? "ok" : "fail";
  }
  return row.ok ? "ok" : "fail";
}

export function formatTable(rows: BenchRow[]): string {
  const headers = ["scenario", "backend", "graph", "param", "ops/s", "p50", "p99", "n", "errors", "ok"];
  const body = rows.map((row) => [
    row.scenario,
    row.backend,
    row.graph,
    row.param ?? "-",
    fmtOps(row.opsPerSec),
    fmtMs(row.p50Ms),
    fmtMs(row.p99Ms),
    String(row.n),
    String(row.errors),
    fmtOk(row),
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...body.map((cells) => cells[i]!.length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => pad(cell, widths[i]!, i >= 4))
      .join("  ");
  return [line(headers), ...body.map(line)].join("\n");
}

export function formatJson(rows: BenchRow[]): string {
  return `${JSON.stringify(rows, null, 2)}\n`;
}

export function printReport(rows: BenchRow[], asJson: boolean): void {
  process.stdout.write(asJson ? formatJson(rows) : `${formatTable(rows)}\n`);
}

export function rowFailed(row: BenchRow): boolean {
  if (row.errors > 0 || row.n === 0) {
    return true;
  }
  return row.ok === false;
}
