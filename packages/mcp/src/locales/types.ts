import type { GraphSearchModes } from "@collabnode/runtime";

export interface McpLocaleCatalog {
  prompts: {
    systemPromptDescription: (name: string) => string;
    agentRoleDescription: (role: string) => string;
    agentActingText: (role: string, documentId: string) => string;
    workOnDescription: (type: string) => string;
    workOnDerivedCallHelp: (toolName: string) => string;
    workOnCallHelp: (toolName: string) => string;
    linkDescription: (type: string) => string;
    linkCallHelp: (toolName: string) => string;
    roleHeader: (role: string, systemPrompt: string) => string;
    collaboratingOnWorkspace: (name: string, documentId: string) => string;
    collaboratingOnGraph: (name: string, schemaId: string, documentId: string) => string;
    activeActor: (actorId: string) => string;
    rulesHeader: string;
    rules: {
      multiParticipant: string;
      preferTargetedReads: string;
      searchBeforeCreate: string;
      identityMatching: string;
      tagsSupported: string;
    };
    nodeTypesHeader: string;
    edgeTypesHeader: string;
    none: string;
    identityFields: (fields: string) => string;
    singleInstance: string;
    propertiesHeader: string;
    derivedHeader: string;
    guidelinesHeader: string;
    edgeConnects: (from: string, to: string) => string;
    propertyKeywords: {
      integer: string;
      min: (val: number) => string;
      max: (val: number) => string;
      maxLength: (val: number) => string;
      required: string;
      default: (val: string) => string;
      derived: (val: string) => string;
    };
    promptArgsDescription: string;
  };
  tools: {
    guidelinesBlurb: (guidelines: string) => string;
    describe: string;
    list: {
      description: string;
      types: string;
      tag: string;
      q: string;
      limit: string;
      offset: string;
    };
    get: {
      description: string;
      id: string;
    };
    search: {
      description: (modes: GraphSearchModes) => string;
      qVector: string;
      qText: string;
      types: string;
      tag: string;
      limit: string;
    };
    similar: {
      description: string;
      id: string;
      types: string;
      limit: string;
    };
    neighbors: {
      description: string;
      depth: string;
      limit: string;
    };
    snapshot: {
      description: string;
      types: string;
      includeText: string;
    };
    query: {
      description: (graphKind: string, exampleType: string) => string;
      cypher: string;
      params: string;
      limit: string;
    };
    history: {
      description: string;
      limit: string;
    };
    changes: {
      description: string;
      since: string;
      limit: string;
    };
    actors: string;
    deleteNode: string;
    deleteEdge: string;
    applyBatch: {
      description: string;
      ops: string;
    };
    diffSince: {
      description: string;
      previousSnapshot: string;
    };
    upsertNode: (type: string, description: string, guidelinesBlurb: string) => string;
    upsertSingletonNode: (type: string, description: string, guidelinesBlurb: string) => string;
    upsertEdge: (
      type: string,
      from: string,
      to: string,
      description: string,
      guidelinesBlurb: string,
    ) => string;
    namedTool: (name: string) => string;
    view: {
      /** Description of a generated `view_<name>` tool. */
      description: (name: string, description: string, guidanceBlurb: string) => string;
      guidanceBlurb: (guidance: string) => string;
    };
    nodeRef: {
      idOrPrefix: string;
      identityObject: string;
    };
    plan: {
      /** The `ref` a plan gives a node it is creating. */
      nodeRef: string;
      /** The id of an existing node a plan entry updates. */
      nodeId: string;
      /** An edge endpoint: an existing node's id, or a `ref` from this plan. */
      endpoint: string;
      nodes: string;
      edges: string;
      /** Guidance appended to a node type's own description. */
      relationshipsAreEdges: string;
      /** Bounds moved out of the JSON schema and into the description. */
      numberRange: (min: number | undefined, max: number | undefined) => string;
      maxLength: (max: number) => string;
    };
    nodeUpsert: {
      id: string;
      tags: string;
      missingRequiredProperty: (propName: string) => string;
    };
    edgeUpsert: {
      from: (types: string) => string;
      to: (types: string) => string;
    };
    namedToolInput: {
      id: (type: string) => string;
      tags: string;
      intoParent: (intoType: string, toTypes: string) => string;
    };
    policy: {
      readOnlyNodeType: (type: string) => string;
      readOnlyEdgeType: (type: string) => string;
      unknownBatchOp: (op: string) => string;
    };
    propertyDescriptions: {
      datetime: string;
      datetimeWithDesc: (desc: string) => string;
      textWithDesc: (desc: string) => string;
      textDefault: string;
    };
  };
  resources: {
    schema: (name: string) => string;
    snapshot: string;
    nodeGuidelines: (type: string) => string;
    edgeGuidelines: (type: string) => string;
  };
}
