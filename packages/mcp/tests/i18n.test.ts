import { InMemoryCollabBackend } from "@collabnode/collab";
import { InMemoryGraphStore } from "@collabnode/graph";
import { createHub } from "@collabnode/hub";
import { CollabSession } from "@collabnode/runtime";
import { parseSchemaDocument, parseWorkspaceTypeDocument } from "@collabnode/schema";
import { describe, expect, it } from "vitest";
import {
  buildTools,
  createGraphMcpServer,
  createHubMcpHandler,
  createWorkspaceMcpServer,
  generatePrompts,
  generateResources,
  getLocale,
  normalizeLanguage,
  queryToolDescription,
  registerLocale,
  searchToolDescription,
  similarToolDescription,
  type McpLocaleCatalog,
} from "../src/index.ts";

const TASK_SCHEMA = parseSchemaDocument(`
name: TaskBoard
version: 1
config:
  schemaId: task-board
  tags:
    enabled: true
nodes:
  Task:
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
    guidelines:
      - Short titles
  Person:
    properties:
      name:
        type: string
        required: true
edges:
  ASSIGNED_TO:
    from: [Task]
    to: [Person]
    properties:
      since:
        type: datetime
    guidelines:
      - Single assignee
`);

const WORKSPACE_TYPE = parseWorkspaceTypeDocument(`
type: retro
version: 1
schema:
  nodes:
    Column:
      properties:
        title: { type: string, required: true }
    Item:
      properties:
        body: { type: string, required: true }
  edges:
    IN_COLUMN:
      from: [Item]
      to: [Column]
tools:
  expose:
    - graph_describe
    - graph_search
  named:
    add_item:
      description: "Add a retro item directly into a column"
      creates: Item
      into: IN_COLUMN
  agents:
    - role: facilitator
      actorId: bot-facilitator
      description: "Facilitator agent"
      systemPrompt: "You are the facilitator."
      tools:
        - add_item
`);

describe("i18n language normalization and locale registry", () => {
  it("normalizes language strings accurately", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("english")).toBe("en");
    expect(normalizeLanguage("en-US")).toBe("en");
    expect(normalizeLanguage("es")).toBe("es");
    expect(normalizeLanguage("ES")).toBe("es");
    expect(normalizeLanguage("spanish")).toBe("es");
    expect(normalizeLanguage("español")).toBe("es");
    expect(normalizeLanguage("espanol")).toBe("es");
    expect(normalizeLanguage("es-ES")).toBe("es");
    expect(normalizeLanguage("es-MX")).toBe("es");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage(null)).toBe("en");
  });

  it("allows registering new languages without modifying core code", () => {
    const customCatalog: McpLocaleCatalog = {
      prompts: {
        systemPromptDescription: (name) => `Invite système pour ${name}`,
        agentRoleDescription: (role) => `Invite de rôle pour ${role}`,
        agentActingText: (role, documentId) => `Vous agissez en tant que ${role} dans ${documentId}.`,
        workOnDescription: (type) => `Comment créer ou mettre à jour ${type}`,
        workOnDerivedCallHelp: (toolName) => `Appelez ${toolName}.`,
        workOnCallHelp: (toolName) => `Appelez ${toolName}.`,
        linkDescription: (type) => `Comment lier ${type}`,
        linkCallHelp: (toolName) => `Appelez ${toolName}.`,
        roleHeader: (role, systemPrompt) => `## Rôle: ${role}\n${systemPrompt}\n\n`,
        collaboratingOnWorkspace: (name, id) => `Vous collaborez sur ${name} (${id}).`,
        collaboratingOnGraph: (name, schemaId, id) => `Vous collaborez sur le graphe ${name} (${schemaId}, id: ${id}).`,
        activeActor: (actorId) => `Acteur actif: ${actorId}`,
        rulesHeader: "## Règles de collaboration",
        rules: {
          multiParticipant: "- Plusieurs participants.",
          preferTargetedReads: "- Préférez graph_list.",
          searchBeforeCreate: "- Recherchez d'abord.",
          identityMatching: "- Clés d'identité.",
          tagsSupported: "- Tags supportés.",
        },
        nodeTypesHeader: "## Types de nœuds",
        edgeTypesHeader: "## Types de relations",
        none: "(aucun)",
        identityFields: (fields) => `- Champs d'identité: [${fields}]`,
        propertiesHeader: "- Propriétés:",
        derivedHeader: "- Dérivé:",
        guidelinesHeader: "- Directives:",
        edgeConnects: (from, to) => `- Connecte: (${from}) -> (${to})`,
        propertyKeywords: {
          integer: "entier",
          min: (val) => `min ${val}`,
          max: (val) => `max ${val}`,
          maxLength: (val) => `longueurMax ${val}`,
          required: "requis",
          default: (val) => `défaut: ${val}`,
          derived: (val) => `dérivé: ${val}`,
        },
        promptArgsDescription: "Langue pour l'invite (ex: 'fr', 'en', 'es')",
      },
      tools: {
        guidelinesBlurb: (guidelines) => ` Directives: ${guidelines}`,
        describe: "Renvoie le contrat de graphe.",
        list: {
          description: "Index compact.",
          types: "Types.",
          tag: "Tag.",
          q: "Filtre.",
          limit: "Limite.",
          offset: "Offset.",
        },
        get: {
          description: "Renvoie un nœud.",
          id: "Id.",
        },
        search: {
          description: () => "Recherche dans le graphe.",
          qVector: "Recherche.",
          qText: "Recherche texte.",
          types: "Types.",
          tag: "Tag.",
          limit: "Limite.",
        },
        similar: {
          description: "Nœuds similaires.",
          id: "Id.",
          types: "Types.",
          limit: "Limite.",
        },
        neighbors: {
          description: "Voisins.",
          depth: "Profondeur.",
          limit: "Limite.",
        },
        snapshot: {
          description: "Capture du graphe.",
          types: "Types.",
          includeText: "Inclure texte.",
        },
        query: {
          description: () => "Requête Cypher.",
          cypher: "Requête.",
          params: "Paramètres.",
          limit: "Limite.",
        },
        history: {
          description: "Historique.",
          limit: "Limite.",
        },
        changes: {
          description: "Modifications.",
          since: "Depuis.",
          limit: "Limite.",
        },
        actors: "Acteurs.",
        deleteNode: "Supprimer un nœud.",
        deleteEdge: "Supprimer une arête.",
        upsertNode: (type) => `Créer ou modifier ${type}`,
        upsertEdge: (type) => `Créer ou modifier relation ${type}`,
        namedTool: (name) => `Outil nommé ${name}`,
        nodeRef: {
          idOrPrefix: "Id nœud.",
          identityObject: "Objet identité.",
        },
        nodeUpsert: {
          id: "Id.",
          tags: "Tags.",
          missingRequiredProperty: (prop) => `propriété requise manquante '${prop}'`,
        },
        edgeUpsert: {
          from: (types) => `Origine (${types})`,
          to: (types) => `Cible (${types})`,
        },
        namedToolInput: {
          id: (type) => `Id de ${type}`,
          tags: "Tags.",
          intoParent: (intoType, toTypes) => `Parent ${intoType} (${toTypes})`,
        },
        propertyDescriptions: {
          datetime: "Date-heure ISO-8601",
          datetimeWithDesc: (desc) => `${desc} (date-heure ISO-8601)`,
          textWithDesc: (desc) => `${desc}.`,
          textDefault: "Texte.",
        },
      },
      resources: {
        schema: (name) => `Schéma pour ${name}`,
        snapshot: "Instantané du graphe",
        nodeGuidelines: (type) => `Directives pour ${type}`,
        edgeGuidelines: (type) => `Directives pour relation ${type}`,
      },
    };

    registerLocale("fr", customCatalog);
    const resolved = getLocale("fr");
    expect(resolved.prompts.none).toBe("(aucun)");

    const frPrompts = generatePrompts(TASK_SCHEMA, { documentId: "doc-fr", language: "fr" });
    const sysPrompt = frPrompts.find((p) => p.name === "graph-system")!;
    expect(sysPrompt.text).toContain("Vous collaborez sur le graphe TaskBoard");
    expect(sysPrompt.text).toContain("## Règles de collaboration");
    expect(sysPrompt.text).toContain("## Types de nœuds");
  });
});

describe("i18n tool descriptions and schemas", () => {
  it("builds tools in Spanish when language is 'es'", async () => {
    const host = await CollabSession.open(undefined, {
      schema: TASK_SCHEMA,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });

    const tools = buildTools(TASK_SCHEMA, host, { language: "es" });
    const describeTool = tools.find((t) => t.name === "graph_describe")!;
    expect(describeTool.description).toContain("Devuelve el contrato del grafo");

    const listTool = tools.find((t) => t.name === "graph_list")!;
    expect(listTool.description).toContain("Índice compacto de nodos");

    const getTool = tools.find((t) => t.name === "graph_get")!;
    expect(getTool.description).toContain("Devuelve un nodo o arista por id");

    const delNodeTool = tools.find((t) => t.name === "graph_delete_node")!;
    expect(delNodeTool.description).toContain("Elimina un nodo y sus aristas incidentes");

    const delEdgeTool = tools.find((t) => t.name === "graph_delete_edge")!;
    expect(delEdgeTool.description).toContain("Elimina una arista del grafo compartido");

    const upsertTask = tools.find((t) => t.name === "upsert_node_Task")!;
    expect(upsertTask.description).toContain("Crea o actualiza un nodo Task.");
    expect(upsertTask.description).toContain("Directrices: Short titles");

    const upsertEdge = tools.find((t) => t.name === "upsert_edge_ASSIGNED_TO")!;
    expect(upsertEdge.description).toContain("Crea o actualiza una arista ASSIGNED_TO");
    expect(upsertEdge.description).toContain("Directrices: Single assignee");

    await host.close();
  });

  it("provides localized tool description helpers", () => {
    const modesAll = { text: true, vector: true };
    const modesText = { text: true, vector: false };
    const modesNone = { text: false, vector: false };

    expect(searchToolDescription(modesAll, "es")).toContain("Búsqueda clasificada por redacción y significado a la vez");
    expect(searchToolDescription(modesText, "es")).toContain("Búsqueda de texto completo clasificada");
    expect(searchToolDescription(modesNone, "es")).toContain("Encuentra nodos cuyas propiedades o etiquetas contengan q");

    expect(similarToolDescription("es")).toContain("Nodos similares a un nodo dado");
    expect(queryToolDescription("ladybug", TASK_SCHEMA, "es")).toContain("Ejecuta una consulta Cypher de solo lectura");
    expect(queryToolDescription("age", TASK_SCHEMA, "es")).toContain("Ejecuta openCypher de solo lectura");
    expect(queryToolDescription("memory", TASK_SCHEMA, "es")).toContain("Ejecuta una consulta de grafo de solo lectura");
  });
});

describe("i18n resources", () => {
  it("generates resource descriptions in Spanish", async () => {
    const host = await CollabSession.open(undefined, {
      schema: TASK_SCHEMA,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });

    const resources = generateResources(TASK_SCHEMA, host, { language: "es" });
    const schemaRes = resources.find((r) => r.uri === "collabnode://schema")!;
    expect(schemaRes.description).toContain("GraphSchema derivado de YAML para TaskBoard");

    const snapRes = resources.find((r) => r.uri === "collabnode://snapshot")!;
    expect(snapRes.description).toContain("Instancia de grafo colaborativo en vivo");

    const nodeGuideRes = resources.find((r) => r.uri === "collabnode://guidelines/node/Task")!;
    expect(nodeGuideRes.description).toContain("Directrices del agente para el tipo de nodo Task");

    const edgeGuideRes = resources.find((r) => r.uri === "collabnode://guidelines/edge/ASSIGNED_TO")!;
    expect(edgeGuideRes.description).toContain("Directrices del agente para el tipo de arista ASSIGNED_TO");

    await host.close();
  });
});

describe("i18n MCP Server dynamic prompt generation by caller", () => {
  it("allows caller to specify language when executing prompts", async () => {
    const host = await CollabSession.open(undefined, {
      schema: TASK_SCHEMA,
      collab: new InMemoryCollabBackend(),
      graph: new InMemoryGraphStore(),
      actorId: "host",
    });

    const server = createGraphMcpServer(host, { language: "en" });
    const promptDef = (server as any)._registeredPrompts["graph-system"];
    expect(promptDef).toBeDefined();

    // Default call without language argument
    const defaultRes = await promptDef.handler({});
    expect(defaultRes.messages[0].content.text).toContain("You are collaborating on graph \"TaskBoard\"");
    expect(defaultRes.messages[0].content.text).toContain("## Collaboration & Graph Rules");

    // Caller passes language: "es"
    const esRes = await promptDef.handler({ language: "es" });
    expect(esRes.messages[0].content.text).toContain("Estás colaborando en el grafo \"TaskBoard\"");
    expect(esRes.messages[0].content.text).toContain("## Reglas de colaboración y grafo");

    // Caller passes language: "spanish"
    const spanishRes = await promptDef.handler({ language: "spanish" });
    expect(spanishRes.messages[0].content.text).toContain("Estás colaborando en el grafo \"TaskBoard\"");

    // Node prompt with language: "es"
    const taskPromptDef = (server as any)._registeredPrompts["work-on-Task"];
    const taskEsRes = await taskPromptDef.handler({ language: "es" });
    expect(taskEsRes.messages[0].content.text).toContain("Campos de identidad: [title]");
    expect(taskEsRes.messages[0].content.text).toContain("Llama a la herramienta `upsert_node_Task`");

    await host.close();
  });

  it("handles workspace MCP server with agent roles in Spanish", async () => {
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(WORKSPACE_TYPE);
    const ws = await hub.open("retro", { id: "retro-i18n-1", actorId: "ada" });

    const server = createWorkspaceMcpServer(ws, {
      language: "es",
      agentRole: "facilitator",
    });

    const sysPromptDef = (server as any)._registeredPrompts["graph-system"];
    const res = await sysPromptDef.handler({});
    expect(res.messages[0].content.text).toContain("## Rol: facilitator");
    expect(res.messages[0].content.text).toContain("Estás colaborando en el espacio de trabajo \"retro\"");
    expect(res.messages[0].content.text).toContain("## Reglas de colaboración y grafo");

    // Dynamic switch to English by caller
    const enRes = await sysPromptDef.handler({ language: "en" });
    expect(enRes.messages[0].content.text).toContain("## Role: facilitator");
    expect(enRes.messages[0].content.text).toContain("You are collaborating on workspace \"retro\"");

    await hub.close();
  });
});

describe("i18n HTTP and Hub MCP handlers", () => {
  it("resolves language in createHubMcpHandler from query param and language option", async () => {
    const hub = await createHub({ sweepIntervalMs: 0 });
    hub.define(WORKSPACE_TYPE);
    await hub.open("retro", { id: "retro-http-i18n", actorId: "ada" });

    const handler = createHubMcpHandler(hub, {
      language: "en",
    });

    const initPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0" },
      },
    };

    // Request with ?lang=es
    const reqEs = new Request("http://127.0.0.1/mcp/w/retro-http-i18n?lang=es", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      },
      body: JSON.stringify(initPayload),
    });
    const resEs = await handler(reqEs);
    expect(resEs.status).toBe(200);

    // Request with Accept-Language: es
    const reqHeader = new Request("http://127.0.0.1/mcp/w/retro-http-i18n", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Accept-Language": "es-ES,es;q=0.9",
      },
      body: JSON.stringify(initPayload),
    });
    const resHeader = await handler(reqHeader);
    expect(resHeader.status).toBe(200);

    await hub.close();
  });
});
