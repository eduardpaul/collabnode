import type { McpLocaleCatalog } from "./types.js";

export const EN_CATALOG: McpLocaleCatalog = {
  prompts: {
    systemPromptDescription: (name) => `System prompt for collaborating on ${name}`,
    agentRoleDescription: (role) => `Role prompt for ${role}`,
    agentActingText: (role, documentId) => `You are acting as the ${role} in workspace ${documentId}.`,
    workOnDescription: (type) => `How to create or update ${type} nodes`,
    workOnDerivedCallHelp: (toolName) =>
      `Call tool \`${toolName}\` with the writable properties above. Omit id unless updating a known node. Do not send derived fields; the server computes them.`,
    workOnCallHelp: (toolName) =>
      `Call tool \`${toolName}\` with the properties above. Omit id unless updating a known node.`,
    linkDescription: (type) => `How to create ${type} edges`,
    linkCallHelp: (toolName) => `Call tool \`${toolName}\` with from and to node ids.`,
    roleHeader: (role, systemPrompt) => `## Role: ${role}\n${systemPrompt}\n\n`,
    collaboratingOnWorkspace: (name, documentId) => `You are collaborating on workspace "${name}" (${documentId}).`,
    collaboratingOnGraph: (name, schemaId, documentId) =>
      `You are collaborating on graph "${name}" (${schemaId}, id: ${documentId}).`,
    activeActor: (actorId) => `Active actor: ${actorId}`,
    rulesHeader: "## Collaboration & Graph Rules",
    rules: {
      multiParticipant: "- Multiple participants and agents share this workspace in real time.",
      preferTargetedReads: "- Prefer graph_list, graph_get, graph_search, and graph_neighbors over graph_snapshot.",
      searchBeforeCreate: "- Search or inspect existing entities before creating new ones to prevent duplicate nodes.",
      identityMatching:
        "- For identity-keyed entities, matching property values will find and update the existing node automatically (omit ID on create).",
      tagsSupported: "- Tags are supported on nodes. Pass tags[] to set or replace tags; pass [] to clear.",
    },
    nodeTypesHeader: "## Node types",
    edgeTypesHeader: "## Edge types",
    none: "(none)",
    identityFields: (fields) => `- Identity fields: [${fields}] (matching values update the existing node)`,
    propertiesHeader: "- Properties:",
    derivedHeader: "- Derived (read-only, computed by the server; do not send):",
    guidelinesHeader: "- Guidelines:",
    edgeConnects: (from, to) => `- Connects: (${from}) -> (${to})`,
    propertyKeywords: {
      integer: "integer",
      min: (val) => `min ${val}`,
      max: (val) => `max ${val}`,
      maxLength: (val) => `maxLength ${val}`,
      required: "required",
      default: (val) => `default: ${val}`,
      derived: (val) => `derived: ${val} (read-only, computed by the server)`,
    },
    promptArgsDescription: "Language for the prompt (e.g. 'en', 'es', 'spanish', 'english')",
  },
  tools: {
    guidelinesBlurb: (guidelines) => ` Guidelines: ${guidelines}`,
    describe:
      "Return the graph contract: types, properties, identity keys, guidelines, document id, and actor. Call this first if you do not have the graph-system prompt.",
    list: {
      description:
        "Compact index of nodes (id, type, label, key properties). Filter by types, tag, or substring q, with stable offset paging. Use graph_search instead when you are looking for something by name. Prefer this over graph_snapshot.",
      types: "Restrict to these node types.",
      tag: "Require this exact tag.",
      q: "Optional substring filter, ignoring case and punctuation. This is a filter, not a ranked search — results stay in a stable order for paging.",
      limit: "Max results (default 20, max 100).",
      offset: "Skip this many matches (default 0).",
    },
    get: {
      description:
        "Return one node or edge by id (or unique id prefix), plus incident edges (ids, types, labels). Prefer this over graph_snapshot.",
      id: "Full id or unique prefix of at least 4 characters.",
    },
    search: {
      description: (modes) => {
        const shared =
          "q is optional when types or tag is set. String values in results are truncated to 240 characters.";
        if (!modes.text && !modes.vector) {
          return `Find nodes biological properties or tags contain q, as a substring. Results are in graph order and carry no relevance score, because this projection has no full-text index. ${shared}`;
        }
        if (!modes.vector) {
          return `Ranked full-text search over indexed properties and tags, run by the graph store's own index. Tolerates case, accents, punctuation, word order, and plurals, so 'Stand-Up' finds a note titled 'Standup'. Best hit first — prefer this over graph_list when looking something up by name. ${shared}`;
        }
        return `Ranked search over wording and meaning at once, run by the graph store's own indexes. Wording: 'Stand-Up' finds the note titled 'Standup', through case, accents, punctuation, word order and plurals. Meaning: 'what did we decide about hiring' finds notes about hiring that never use the word, so ask in the user's own phrasing rather than guessing keywords. Best hit first, and every hit says how it matched — 'text' by wording, 'vector' by meaning, 'both' when the two agree. A 'vector' hit is about the subject; it is not necessarily called that. ${shared}`;
      },
      qVector:
        "What to look for, in the user's own words. A name, or a whole question — meaning is matched as well as wording, so a full phrase works better here than keywords. Ranked hits carry a score and a match kind, best first; both are absent when the hit came from the substring fallback.",
      qText:
        "What to look for. Matched against labels, indexed properties, and tags; case, accents, punctuation, and word order are ignored. Ranked hits carry a score, best first; a score is absent when the hit came from the substring fallback.",
      types: "Restrict to these node types.",
      tag: "Require this exact tag.",
      limit: "Max results (default 20, max 100).",
    },
    similar: {
      description:
        "Nodes that read like a given node, ranked by meaning. Takes a node id, not a search string, so use it for 'more like this', 'related notes', or finding near-duplicates before creating something new. Returns nothing about the node itself.",
      id: "Id (or unique prefix) of the node to find neighbours in meaning for.",
      types: "Restrict to these node types.",
      limit: "Max results (default 20, max 100).",
    },
    neighbors: {
      description:
        "Return neighbors of a node. Filter by edgeTypes and direction (in | out | both). depth is 1 (default) or 2. Neighbor count is capped (default 100). Long strings are truncated; use graph_get for full text.",
      depth: "Walk depth: 1 (default) or 2.",
      limit: "Max neighbors (default 100, max 100).",
    },
    snapshot: {
      description:
        "Return the collaborative graph. Prefer graph_list / graph_get / graph_search / graph_neighbors. Filter by node/edge types. includeText defaults to false and replaces long strings with {truncated, length}.",
      types: "Node and/or edge types to include.",
      includeText:
        "When false (default), string values longer than 240 characters become {truncated: true, length}.",
    },
    query: {
      description: (graphKind, exampleType) => {
        const example = `Example: MATCH (n:${exampleType}) RETURN n. Writes must use upsert/delete tools.`;
        if (graphKind === "ladybug") {
          return `Run a read-only Cypher query against the Ladybug projection. ${example}`;
        }
        if (graphKind === "age") {
          return `Run read-only openCypher against the Apache AGE projection. ${example}`;
        }
        return `Run a read-only graph query against the local projection. The in-memory store supports only \`MATCH (n:Type) RETURN n\` and \`MATCH (a)-[r:TYPE]->(b) RETURN ...\`. ${example}`;
      },
      cypher: "Read-only MATCH/RETURN query. CREATE/MERGE/SET/DELETE are rejected.",
      params: "Optional query parameters.",
      limit: "Max rows (default 50, max 100).",
    },
    history: {
      description:
        "Return the persisted change-tracking log. Empty unless config.changeTracking.mode is history. Filter by entity id, actorId, since (ISO), and limit.",
      limit: "Max entries (default 50, max 100).",
    },
    changes: {
      description:
        "Return recent writes. Uses the history log when changeTracking.mode is history; otherwise last-write meta stamps (deletes omitted). Pass the returned cursor as since on the next call.",
      since: "ISO-8601 timestamp; return writes at or after this time.",
      limit: "Max events (default 50, max 100).",
    },
    actors: "List actors who have created or updated nodes/edges on this document (from meta stamps).",
    deleteNode: "Delete a node and its incident edges from the shared graph. Fails if the id does not exist.",
    deleteEdge: "Delete an edge from the shared graph. Fails if the id does not exist.",
    applyBatch: {
      description:
        "Apply several node and edge writes as one atomic batch. Use ref to point an edge at a node created in the same batch. Every operation is subject to the same write rules as the individual tools.",
      ops: "Operations in order: {op: 'upsertNode', type, ref?, id?, properties?, tags?}, {op: 'upsertEdge', type, from, to, properties?}, {op: 'deleteNode', id}, {op: 'deleteEdge', id}.",
    },
    diffSince: {
      description:
        "Compare a snapshot you took earlier against the current graph and return what changed, as ops and as readable Markdown.",
      previousSnapshot: "A GraphSnapshot returned by an earlier graph_snapshot call.",
    },
    upsertNode: (type, description, guidelinesBlurb) => {
      const descPart = description ? ` ${description}` : "";
      return `Create or update a ${type} node.${descPart}${guidelinesBlurb}`;
    },
    upsertEdge: (type, from, to, description, guidelinesBlurb) => {
      const descPart = description ? ` ${description}` : "";
      return `Create or update a ${type} edge from ${from} to ${to}.${descPart} Reuses an existing edge with the same endpoints unless id is set.${guidelinesBlurb}`;
    },
    namedTool: (name) => `Named tool ${name}`,
    nodeRef: {
      idOrPrefix: "Node id or unique id prefix (min 4 characters).",
      identityObject: "Identity object, e.g. { type: 'Task', title: 'Ship' } or { id: '...' }.",
    },
    nodeUpsert: {
      id: "Existing node id. Omit on create; identity-keyed types find-or-update from identity fields. Random ids are ignored when identity fields match an existing node.",
      tags: "Replace the tag set. Omit to leave existing tags; pass [] to clear.",
      missingRequiredProperty: (propName) => `missing required property '${propName}'`,
    },
    edgeUpsert: {
      from: (types) => `Source node (${types}): id, unique prefix, or { type, ...identity }`,
      to: (types) => `Target node (${types}): id, unique prefix, or { type, ...identity }`,
    },
    namedToolInput: {
      id: (type) => `Optional id of the ${type} node (generated if omitted).`,
      tags: "Optional tags.",
      intoParent: (intoType, toTypes) =>
        `Target parent node id (or unique prefix) to connect into via ${intoType} (${toTypes}).`,
    },
    policy: {
      readOnlyNodeType: (type) =>
        `${type} nodes are read-only for this agent role: they can be read but not created, updated or deleted.`,
      readOnlyEdgeType: (type) =>
        `${type} edges are read-only for this agent role: attaching or detaching one would change how its endpoints read to everyone else.`,
      unknownBatchOp: (op) =>
        `Unknown batch operation '${op}'. Use upsertNode, upsertEdge, deleteNode or deleteEdge.`,
    },
    propertyDescriptions: {
      datetime: "ISO-8601 datetime",
      datetimeWithDesc: (desc) => `${desc} (ISO-8601 datetime)`,
      textWithDesc: (desc) =>
        `${desc}. Pass the full text here; writing it only in chat does not store it.`,
      textDefault: "Full text content. Pass it on this field; writing it only in chat does not store it.",
    },
  },
  resources: {
    schema: (name) => `YAML-derived GraphSchema for ${name}`,
    snapshot:
      "Live collaborative graph instance with long strings truncated. Use graph_get or graph_snapshot({ includeText: true }) for full text.",
    nodeGuidelines: (type) => `Agent guidelines for node type ${type}`,
    edgeGuidelines: (type) => `Agent guidelines for edge type ${type}`,
  },
};
