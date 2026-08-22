import { SchemaFactory } from "fluid-framework";

/**
 * Generic property-graph encoding. Node/edge *types* live in YAML, not in this
 * SharedTree schema, so a Loro (or other) backend can use the same GraphOp
 * document shape and YAML changes do not require a new Fluid schema.
 *
 * v2: per-key property map, tagsJson, history array. Breaking vs collabnode.graph.v1.
 */
export const schemaFactory = new SchemaFactory("collabnode.graph.v2");

export class GraphNode extends schemaFactory.object("GraphNode", {
  type: schemaFactory.string,
  properties: schemaFactory.map(schemaFactory.string),
  tagsJson: schemaFactory.string,
  metaJson: schemaFactory.string,
}) {}

export class GraphEdge extends schemaFactory.object("GraphEdge", {
  type: schemaFactory.string,
  from: schemaFactory.string,
  to: schemaFactory.string,
  properties: schemaFactory.map(schemaFactory.string),
  metaJson: schemaFactory.string,
}) {}

export class GraphDocument extends schemaFactory.object("GraphDocument", {
  schemaId: schemaFactory.string,
  schemaHash: schemaFactory.string,
  nodes: schemaFactory.map(GraphNode),
  edges: schemaFactory.map(GraphEdge),
  history: schemaFactory.array(schemaFactory.string),
  historyLimit: schemaFactory.number,
}) {}
