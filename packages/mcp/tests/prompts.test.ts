import { parseSchemaDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import { generatePrompts, promptName } from "../src/index.ts";

const TASK_BOARD_YAML = `
name: TaskBoard
version: 1
description: Collaborative task board
config:
  schemaId: task-board
  idStrategy: uuid
  display:
    title: Task Board
  changeTracking:
    enabled: false
    mode: last-write
nodes:
  Task:
    description: A work item
    identity:
      from: [title]
    properties:
      title:
        type: string
        required: true
      status:
        type: enum
        values: [todo, doing, done]
        default: todo
      estimate:
        type: number
    ui:
      label: "{title}"
      icon: check-square
    guidelines:
      - Titles are imperative and short
  Person:
    properties:
      name:
        type: string
        required: true
      email:
        type: string
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    directed: true
    properties:
      since:
        type: datetime
    ui:
      label: assigned
    guidelines:
      - Prefer a single assignee per task
  BLOCKS:
    from: [Task]
    to: [Task]
    directed: true
`;

const schema = parseSchemaDocument(TASK_BOARD_YAML);

describe("generatePrompts", () => {
  it("emits system, per-node, and per-edge prompts with guidelines", () => {
    const prompts = generatePrompts(schema, { documentId: "doc-1", actorId: "agent-1" });
    const names = prompts.map((prompt) => prompt.name);
    expect(names).toEqual([
      "graph-system",
      promptName("work-on", "Task"),
      promptName("work-on", "Person"),
      promptName("link", "ASSIGNED_TO"),
      promptName("link", "BLOCKS"),
    ]);
    const system = prompts.find((prompt) => prompt.name === "graph-system")!;
    expect(system.text).toContain("task-board");
    expect(system.text).toContain("doc-1");
    expect(system.text).toContain("agent-1");
    // The rule only fires where graph_snapshot exists to be preferred against,
    // and a bare schema has no `tools.advanced` to turn it on.
    expect(system.text).not.toContain("over graph_snapshot");

    const task = prompts.find((prompt) => prompt.name === "work-on-Task")!;
    expect(task.text).toContain("Titles are imperative and short");
    expect(task.text).toContain("todo, doing, done");
    expect(task.text).toContain("upsert_node_Task");
    expect(system.text).not.toMatch(/\bYjs\b|\bTipTap\b|collab field|XmlFragment/i);
    const assigned = prompts.find((prompt) => prompt.name === "link-ASSIGNED_TO")!;
    expect(assigned.text).toContain("Prefer a single assignee per task");
    expect(assigned.text).toContain("Task");
    expect(assigned.text).toContain("Person");
  });

  it("includes integer, min/max, and maxLength on property lines", () => {
    const constrained = parseSchemaDocument(`
name: Constrained
version: 1
config:
  schemaId: constrained
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
        maxLength: 120
      complexity:
        type: number
        integer: true
        min: 0
        max: 5
`);
    const prompts = generatePrompts(constrained, { documentId: "doc-1", actorId: "agent-1" });
    const system = prompts.find((prompt) => prompt.name === "graph-system")!;
    expect(system.text).toContain("maxLength 120");
    expect(system.text).toContain("integer");
    expect(system.text).toContain("min 0");
    expect(system.text).toContain("max 5");
  });

  it("marks derived properties as read-only and tells agents not to send them", () => {
    const scored = parseSchemaDocument(`
name: Scored
version: 1
config:
  schemaId: scored
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
      uncertainty:
        type: number
      effortWeight:
        type: number
        derived: "complexity * (1 + uncertainty / 5)"
`);
    const prompts = generatePrompts(scored, { documentId: "doc-1", actorId: "agent-1" });
    const system = prompts.find((prompt) => prompt.name === "graph-system")!;
    expect(system.text).toContain("Derived (read-only, computed by the server; do not send)");
    expect(system.text).toContain("effortWeight");
    expect(system.text).toContain("read-only, computed by the server");
    const work = prompts.find((prompt) => prompt.name === "work-on-Feature")!;
    expect(work.text).toContain("writable properties");
    expect(work.text).toContain("Do not send derived fields");
  });

  it("emits Spanish prompts and system prompt text when specified", () => {
    const prompts = generatePrompts(
      schema,
      { documentId: "doc-es-1", actorId: "agente-1" },
      "es",
    );
    const system = prompts.find((p) => p.name === "graph-system")!;
    expect(system.description).toContain("Prompt de sistema para colaborar");
    expect(system.text).toContain("Estás colaborando en el grafo \"TaskBoard\"");
    expect(system.text).toContain("doc-es-1");
    expect(system.text).toContain("Actor activo: agente-1");
    expect(system.text).toContain("Reglas de colaboración y grafo");
    expect(system.text).not.toContain("sobre graph_snapshot");
    expect(system.text).toContain("## Tipos de nodo");
    expect(system.text).toContain("## Tipos de arista");
    expect(system.text).toContain("Campos de identidad: [title]");
    expect(system.text).toContain("- Propiedades:");
    expect(system.text).toContain("requerido");
    expect(system.text).toContain("predeterminado: \"todo\"");
    expect(system.text).toContain("- Directrices:");

    const taskPrompt = prompts.find((p) => p.name === "work-on-Task")!;
    expect(taskPrompt.description).toBe("Cómo crear o actualizar nodos Task");
    expect(taskPrompt.text).toContain("Llama a la herramienta `upsert_node_Task` con las propiedades anteriores. Omite el id a menos que actualices un nodo conocido.");

    const linkPrompt = prompts.find((p) => p.name === "link-ASSIGNED_TO")!;
    expect(linkPrompt.description).toBe("Cómo crear aristas ASSIGNED_TO");
    expect(linkPrompt.text).toContain("Llama a la herramienta `upsert_edge_ASSIGNED_TO` con los ids de los nodos from y to.");
  });

  it("generates Spanish prompts for derived properties", () => {
    const scored = parseSchemaDocument(`
name: Scored
version: 1
config:
  schemaId: scored
nodes:
  Feature:
    properties:
      title:
        type: string
        required: true
      complexity:
        type: number
      uncertainty:
        type: number
      effortWeight:
        type: number
        derived: "complexity * (1 + uncertainty / 5)"
`);
    const prompts = generatePrompts(scored, { documentId: "doc-1", language: "spanish" });
    const system = prompts.find((p) => p.name === "graph-system")!;
    expect(system.text).toContain("Derivado (solo lectura, calculado por el servidor; no enviar)");
    expect(system.text).toContain("solo lectura, calculado por el servidor");

    const work = prompts.find((p) => p.name === "work-on-Feature")!;
    expect(work.text).toContain("propiedades editables anteriores");
    expect(work.text).toContain("No envíes campos derivados; el servidor los calcula.");
  });
});
