import type { AgentLog } from "../agent/types.ts";

export interface RubricNode {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface RubricEdge {
  id: string;
  type: string;
  from: string;
  to: string;
}

export interface RubricSnapshot {
  nodes: RubricNode[];
  edges: RubricEdge[];
}

export interface RubricCheck {
  id: string;
  weight: number;
  passed: boolean;
  detail: string;
}

export interface RubricResult {
  score: number;
  failures: string[];
  passed: string[];
  checks: RubricCheck[];
  counts: Record<string, number>;
  titles: Record<string, string[]>;
  toolSequence: string[];
  capped: boolean;
}

const AZURE_REQUIRED = [
  { id: "entra", re: /entra|easy auth|microsoft identity|\baad\b|azure ad/i },
  { id: "cosmos", re: /cosmos/i },
  { id: "appinsights", re: /app(lication)?\s*insights|appinsights/i },
] as const;

const AZURE_OPTIONAL = [{ id: "blob", re: /blob|storage account|azure storage/i }] as const;

function titleOf(node: RubricNode): string {
  return String(node.properties.title ?? node.id);
}

function ofType(snapshot: RubricSnapshot, type: string): RubricNode[] {
  return snapshot.nodes.filter((n) => n.type === type);
}

function c4Kind(node: RubricNode): string {
  return String(node.properties.type ?? "").trim();
}

function isExternal(node: RubricNode): boolean {
  return node.properties.external === true;
}

function toolSequence(logs: AgentLog[]): string[] {
  const seq: string[] = [];
  for (const log of logs) {
    const match = log.text.match(/^🔧\s+(\S+)/);
    if (match) seq.push(match[1]);
  }
  return seq;
}

function hasWhatHow(description: string): boolean {
  return (/\bwhat\s*:/i.test(description) || /\bqué\s*:/i.test(description)) &&
    (/\bhow\s*:/i.test(description) || /\bcómo\s*:/i.test(description));
}

function nodeIds(snapshot: RubricSnapshot): Set<string> {
  return new Set(snapshot.nodes.map((n) => n.id));
}

export function scorePlannerGraph(snapshot: RubricSnapshot, logs: AgentLog[]): RubricResult {
  const epics = ofType(snapshot, "Epic");
  const features = ofType(snapshot, "Feature");
  const tasks = ofType(snapshot, "Task");
  const c4 = ofType(snapshot, "C4DiagramElement");
  const risks = ofType(snapshot, "Risk");
  const ids = nodeIds(snapshot);
  const featureIds = new Set(features.map((n) => n.id));
  const epicIds = new Set(epics.map((n) => n.id));

  const hasFeature = snapshot.edges.filter((e) => e.type === "HAS_FEATURE");
  const hasTask = snapshot.edges.filter((e) => e.type === "HAS_TASK");
  const linkedFeatures = new Set(hasFeature.filter((e) => epicIds.has(e.from)).map((e) => e.to));
  const linkedTasks = new Set(hasTask.filter((e) => featureIds.has(e.from)).map((e) => e.to));

  const persons = c4.filter((n) => c4Kind(n) === "Person");
  const boundaries = c4.filter((n) => c4Kind(n) === "Boundary");
  const containers = c4.filter((n) => c4Kind(n) === "Container");
  const components = c4.filter((n) => c4Kind(n) === "Component");
  const systems = c4.filter((n) => c4Kind(n) === "System");

  const tools = toolSequence(logs);
  const taskCalls = tools.filter((name) => name === "task").length;
  const capped = logs.some((l) => /stopped:|recursion limit|aborted/i.test(l.text));

  const dangling = snapshot.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to));
  const titlesByType: Record<string, string[]> = {};
  const dupes: string[] = [];
  for (const node of snapshot.nodes) {
    if (node.type === "SolutionState") continue;
    const title = titleOf(node).trim().toLowerCase();
    const key = `${node.type}::${title}`;
    titlesByType[node.type] ??= [];
    titlesByType[node.type].push(titleOf(node));
    if (title && titlesByType[node.type].filter((t) => t.trim().toLowerCase() === title).length > 1) {
      if (!dupes.includes(key)) dupes.push(key);
    }
  }

  const missingAzure: string[] = [];
  const wrongAzure: string[] = [];
  for (const svc of AZURE_REQUIRED) {
    const hits = c4.filter((n) => svc.re.test(titleOf(n)));
    if (hits.length === 0) missingAzure.push(svc.id);
    else if (hits.some((n) => c4Kind(n) !== "System" || !isExternal(n))) wrongAzure.push(svc.id);
  }
  for (const svc of AZURE_OPTIONAL) {
    const hits = c4.filter((n) => svc.re.test(titleOf(n)));
    if (hits.some((n) => c4Kind(n) !== "System" || !isExternal(n))) wrongAzure.push(svc.id);
  }

  const business = risks.filter((n) => String(n.properties.category ?? "") === "business");
  const technical = risks.filter((n) => String(n.properties.category ?? "") === "technical");
  const tasksWithWhatHow = tasks.filter((n) => hasWhatHow(String(n.properties.description ?? "")));

  const checks: RubricCheck[] = [
    {
      id: "scope",
      weight: 0.15,
      passed:
        epics.length >= 1 &&
        epics.length <= 2 &&
        features.length >= 2 &&
        features.length <= 4 &&
        features.every((f) => linkedFeatures.has(f.id)),
      detail: `epics=${epics.length} features=${features.length} linkedFeatures=${linkedFeatures.size}`,
    },
    {
      id: "task_once",
      weight: 0.1,
      passed: taskCalls === 1,
      detail: `taskCalls=${taskCalls}`,
    },
    {
      id: "c4_shape",
      weight: 0.2,
      passed:
        persons.length >= 1 &&
        boundaries.length >= 1 &&
        containers.length >= 2 &&
        containers.length <= 4 &&
        components.length === 0,
      detail: `person=${persons.length} boundary=${boundaries.length} container=${containers.length} component=${components.length} system=${systems.length}`,
    },
    {
      id: "azure_external",
      weight: 0.15,
      passed: missingAzure.length === 0 && wrongAzure.length === 0,
      detail: `missing=[${missingAzure.join(",")}] wrongType=[${wrongAzure.join(",")}]`,
    },
    {
      id: "tasks",
      weight: 0.2,
      passed:
        tasks.length >= 3 &&
        tasks.length <= 5 &&
        tasks.every((t) => linkedTasks.has(t.id)) &&
        tasksWithWhatHow.length === tasks.length,
      detail: `tasks=${tasks.length} hasTask=${linkedTasks.size} whatHow=${tasksWithWhatHow.length}`,
    },
    {
      id: "risks_ids",
      weight: 0.1,
      passed: business.length >= 1 && technical.length >= 1 && dangling.length === 0,
      detail: `business=${business.length} technical=${technical.length} danglingEdges=${dangling.length}`,
    },
    {
      id: "clean_finish",
      weight: 0.1,
      passed: dupes.length === 0 && !capped,
      detail: `dupes=${dupes.length} capped=${capped}`,
    },
  ];

  const score = Number(checks.reduce((sum, c) => sum + (c.passed ? c.weight : 0), 0).toFixed(4));
  const failures = checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`);
  const passed = checks.filter((c) => c.passed).map((c) => c.id);

  return {
    score,
    failures,
    passed,
    checks,
    counts: {
      Epic: epics.length,
      Feature: features.length,
      Task: tasks.length,
      C4DiagramElement: c4.length,
      Person: persons.length,
      Boundary: boundaries.length,
      Container: containers.length,
      Component: components.length,
      System: systems.length,
      Risk: risks.length,
      Assumption: ofType(snapshot, "Assumption").length,
    },
    titles: {
      Epic: epics.map(titleOf),
      Feature: features.map(titleOf),
      Task: tasks.map(titleOf),
      C4: c4.map((n) => `${c4Kind(n)}:${titleOf(n)}`),
      Risk: risks.map((n) => `${String(n.properties.category ?? "?")}:${titleOf(n)}`),
    },
    toolSequence: tools,
    capped,
  };
}
