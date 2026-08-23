/**
 * UI strings for the sample app, in the two languages it ships with.
 *
 * The *graph* speaks for itself: node descriptions, guidelines, tool
 * descriptions, and the agent's system prompt are translated in
 * `workspaces/*.yaml` and resolved by `@collabnode/schema`. This file covers
 * only the chrome around it — buttons, captions, prompts — which no schema
 * knows about. Both halves are keyed off the same language, so `?lang=es`
 * switches the page, the MCP tool catalog, and what Echo says back.
 */

export const SUPPORTED_UI_LANGUAGES = ["en", "es"] as const;

export type UiLanguage = (typeof SUPPORTED_UI_LANGUAGES)[number];

export interface UiStrings {
  htmlLang: string;
  /** Azure TTS voice used when the operator has not pinned one in `.env`. */
  speechVoice: string;
  /** ISO-639-1 code handed to input transcription, so it stops guessing. */
  transcribeLanguage: string;

  connecting: string;
  /** The homepage: the board gallery and the create-a-board form. */
  home: {
    title: string;
    subtitle: string;
    createHeading: string;
    createHint: string;
    yourBoards: string;
    empty: string;
    newBoard: string;
    open: string;
    remove: string;
    removeTitle: (name: string) => string;
    confirmRemove: (name: string) => string;
    nameLabel: string;
    namePlaceholder: string;
    optional: string;
    create: string;
    creating: string;
    cancel: string;
    createFailed: string;
    loadFailed: string;
    counts: (nodes: number, edges: number) => string;
    dialogTitle: (type: string) => string;
    backToBoards: string;
    notFound: string;
  };
  header: {
    voiceTitle: string;
    voiceSubtitle: string;
    c4Title: string;
    c4Subtitle: string;
    switchWorkspace: string;
    signedInAs: (actor: string) => string;
  };
  stage: {
    aria: string;
    tapToTalk: string;
    tapToStop: string;
    gettingReady: string;
    conversationAria: string;
    voiceSuggestions: string[];
    c4Suggestions: string[];
  };
  caption: {
    idle: string;
    connecting: string;
    listening: string;
    thinking: string;
    speaking: string;
    error: string;
  };
  speaker: { you: string; agent: string };
  mic: { denied: string; missing: string; failed: string };
  board: {
    aria: string;
    notes: string;
    tasks: string;
    people: string;
    allNotes: string;
    untitled: string;
    emptyNote: string;
    newNote: string;
    newNotePrompt: string;
    untitledTask: string;
    toggleCompletion: string;
    changeStatus: string;
    fromNote: string;
    addTask: string;
    taskTitlePrompt: string;
    priorityPrompt: string;
    unnamed: string;
    taskFallback: string;
    noteCount: (count: number) => string;
    taskCount: (count: number) => string;
    removePerson: (name: string) => string;
    confirmRemovePerson: (name: string) => string;
    addPerson: string;
    personNamePrompt: string;
    status: Record<"todo" | "doing" | "done", string>;
    priority: Record<"low" | "medium" | "high", string>;
  };
  c4: {
    aria: string;
    allElements: string;
    systemsAndPeople: string;
    containers: string;
    components: string;
    addElement: string;
    empty: string;
    unnamed: string;
    node: string;
    uses: string;
    contains: string;
    typePrompt: string;
    namePrompt: string;
    descriptionPrompt: string;
    technologyPrompt: string;
  };
  dev: {
    summary: string;
    checking: string;
    graphCaption: string;
    toolCallsCaption: string;
    toolCallsAria: string;
    ready: (model: string, voice: string, tools: number, mcp: string) => string;
    notConfigured: string;
  };
  voice: {
    notSetUp: string;
    needsKeys: string;
    unreachable: string;
    writeFailed: string;
  };
  /** Plain-language readback of a tool call, for people who do not read tool names. */
  tool: {
    savedNote: (subject: string) => string;
    createdTask: (subject: string) => string;
    addedContainer: (subject: string) => string;
    addedComponent: (subject: string) => string;
    definedSystem: (subject: string) => string;
    addedPerson: (subject: string) => string;
    linkedAuthor: string;
    assignedTask: string;
    linkedTaskToNote: string;
    connectedDependency: string;
    nestedComponent: string;
    opened: (subject: string) => string;
    checkedArchitecture: string;
    searched: string;
  };
  /** Persona prepended to the schema-generated contract, per workspace type. */
  persona: { voiceBoard: string; c4: string };
}

const EN: UiStrings = {
  htmlLang: "en",
  speechVoice: "en-US-AvaNeural",
  transcribeLanguage: "en",
  connecting: "Connecting…",
  home: {
    title: "Boards",
    subtitle: "Open a board to talk to it, or start a new one of either kind.",
    createHeading: "Start a new board",
    createHint: "Each kind brings its own schema, voice tools, and starter graph.",
    yourBoards: "Your boards",
    empty: "No boards yet. Create one above to get started.",
    newBoard: "New board",
    open: "Open",
    remove: "Delete",
    removeTitle: (name) => `Delete ${name}`,
    confirmRemove: (name) => `Delete “${name}”? Everyone still on it will lose the board.`,
    nameLabel: "Board name",
    namePlaceholder: "e.g. Payments Platform",
    optional: "optional",
    create: "Create board",
    creating: "Creating…",
    cancel: "Cancel",
    createFailed: "Could not create the board.",
    loadFailed: "Could not load your boards.",
    counts: (nodes, edges) =>
      `${nodes} ${nodes === 1 ? "node" : "nodes"} · ${edges} ${edges === 1 ? "edge" : "edges"}`,
    dialogTitle: (type) => `New ${type}`,
    backToBoards: "← All boards",
    notFound: "That board no longer exists. It may have been deleted.",
  },
  header: {
    voiceTitle: "Voice Board",
    voiceSubtitle:
      "Talk to your notes & tasks. Dictate notes, create action items, and assign tasks by voice in real time.",
    c4Title: "C4 Architecture Model",
    c4Subtitle:
      "Design software systems, containers, components, and personas by voice and visual graph.",
    switchWorkspace: "Switch workspace schema",
    signedInAs: (actor) => `You are signed in as ${actor}`,
  },
  stage: {
    aria: "Voice",
    tapToTalk: "Tap to talk",
    tapToStop: "Tap to stop",
    gettingReady: "Getting ready…",
    conversationAria: "Conversation",
    voiceSuggestions: [
      "“Create a note called Groceries”",
      "“Add task: Fix audio stutter with high priority”",
      "“Mark task Ship WebRTC reconnection as done”",
      "“What tasks are on the board?”",
    ],
    c4Suggestions: [
      "“Add container Web App with technology React to the core system”",
      "“Add container API Gateway with technology Go”",
      "“Connect Web App to API Gateway with technology HTTPS / REST”",
    ],
  },
  caption: {
    idle: "Ready when you are",
    connecting: "Connecting…",
    listening: "Listening — go ahead",
    thinking: "Thinking…",
    speaking: "Speaking…",
    error: "Something went wrong",
  },
  speaker: { you: "You", agent: "Echo" },
  mic: {
    denied: "No microphone access. Allow the microphone in your browser, then tap again.",
    missing: "No microphone found. Plug one in and tap again.",
    failed: "Could not start the microphone. Tap to try again.",
  },
  board: {
    aria: "Board",
    notes: "Notes",
    tasks: "Tasks",
    people: "People",
    allNotes: "← All notes",
    untitled: "Untitled",
    emptyNote: "Empty note",
    newNote: "New note",
    newNotePrompt: "What should this note be called?",
    untitledTask: "Untitled Task",
    toggleCompletion: "Toggle completion",
    changeStatus: "Click to change status",
    fromNote: "Generated from note",
    addTask: "Add new task",
    taskTitlePrompt: "Task title:",
    priorityPrompt: "Priority (low, medium, high):",
    unnamed: "Unnamed",
    taskFallback: "Task",
    noteCount: (count) => `${count} notes`,
    taskCount: (count) => `${count} tasks`,
    removePerson: (name) => `Remove ${name}`,
    confirmRemovePerson: (name) =>
      `Remove ${name} from the board? Connected task assignments will be unlinked.`,
    addPerson: "Add Person",
    personNamePrompt: "Person name (e.g. Grace, Alan, Turing):",
    status: { todo: "todo", doing: "doing", done: "done" },
    priority: { low: "low", medium: "medium", high: "high" },
  },
  c4: {
    aria: "C4 Architecture",
    allElements: "All Elements",
    systemsAndPeople: "Systems & People",
    containers: "Containers",
    components: "Components",
    addElement: "+ Add Element",
    empty: "No elements found in this category.",
    unnamed: "Unnamed",
    node: "Node",
    uses: "uses →",
    contains: "contains ↳",
    typePrompt: "Element type (SoftwareSystem, Container, Component, Person):",
    namePrompt: "Name:",
    descriptionPrompt: "Description:",
    technologyPrompt: "Technology (e.g. TypeScript, React, PostgreSQL):",
  },
  dev: {
    summary: "Developer view",
    checking: "Checking…",
    graphCaption: "Live graph — CRDT nodes and edges rendered in real time.",
    toolCallsCaption: "Tool calls",
    toolCallsAria: "Tool calls",
    ready: (model, voice, tools, mcp) =>
      `${model} · voice ${voice} · ${tools} graph tools · MCP at ${mcp}`,
    notConfigured:
      "Voice Live not configured. Set AZURE_VOICE_LIVE_ENDPOINT and AZURE_VOICE_LIVE_API_KEY in examples/voice-board/.env, then restart.",
  },
  voice: {
    notSetUp: "Voice isn’t set up yet.",
    needsKeys: "Voice isn’t set up yet — whoever set this up needs to add the Azure keys.",
    unreachable: "Could not reach the server.",
    writeFailed: "That didn’t save. Try saying it again.",
  },
  tool: {
    savedNote: (subject) => (subject ? `Saved note ${subject}` : "Saved your note"),
    createdTask: (subject) => (subject ? `Created task ${subject}` : "Created a task"),
    addedContainer: (subject) => (subject ? `Added container ${subject}` : "Added a container"),
    addedComponent: (subject) => (subject ? `Added component ${subject}` : "Added a component"),
    definedSystem: (subject) => (subject ? `Defined system ${subject}` : "Defined software system"),
    addedPerson: (subject) => (subject ? `Added ${subject}` : "Added a person"),
    linkedAuthor: "Linked note to its author",
    assignedTask: "Assigned task to team member",
    linkedTaskToNote: "Linked task to source note",
    connectedDependency: "Connected dependency relationship",
    nestedComponent: "Nested component inside container/system",
    opened: (subject) => (subject ? `Opened ${subject}` : "Opened an item"),
    checkedArchitecture: "Checked connected architecture elements",
    searched: "Searched the workspace",
  },
  persona: {
    voiceBoard: [
      "You are Echo, an assistant for notes and tasks on a collaborative board.",
      "The user is talking to you out loud while viewing the board in a browser.",
      "Dictate notes, create tasks, assign work, and search by voice.",
      "Speak in one or two short sentences. Confirm what you changed.",
    ].join(" "),
    c4: [
      "You are Echo, a software architecture assistant helping design and explore C4 software architecture models (Systems, Containers, Components, and Users).",
      "The user is talking to you out loud while viewing the live graph in a browser.",
      "Use the provided C4 graph tools for all actions: add_container, add_component, upsert_edge_USES, graph_search, and graph_get.",
      "Speak in one or two short sentences. Confirm what you added or connected.",
    ].join(" "),
  },
};

const ES: UiStrings = {
  htmlLang: "es",
  speechVoice: "es-ES-ElviraNeural",
  transcribeLanguage: "es",
  connecting: "Conectando…",
  home: {
    title: "Tableros",
    subtitle: "Abre un tablero para hablar con él, o crea uno nuevo de cualquiera de los dos tipos.",
    createHeading: "Crear un tablero nuevo",
    createHint: "Cada tipo trae su propio esquema, sus herramientas de voz y su grafo inicial.",
    yourBoards: "Tus tableros",
    empty: "Aún no hay tableros. Crea uno arriba para empezar.",
    newBoard: "Tablero nuevo",
    open: "Abrir",
    remove: "Eliminar",
    removeTitle: (name) => `Eliminar ${name}`,
    confirmRemove: (name) => `¿Eliminar «${name}»? Quien siga dentro perderá el tablero.`,
    nameLabel: "Nombre del tablero",
    namePlaceholder: "ej. Plataforma de Pagos",
    optional: "opcional",
    create: "Crear tablero",
    creating: "Creando…",
    cancel: "Cancelar",
    createFailed: "No se ha podido crear el tablero.",
    loadFailed: "No se han podido cargar tus tableros.",
    counts: (nodes, edges) =>
      `${nodes} ${nodes === 1 ? "nodo" : "nodos"} · ${edges} ${edges === 1 ? "arista" : "aristas"}`,
    dialogTitle: (type) => `Nuevo: ${type}`,
    backToBoards: "← Todos los tableros",
    notFound: "Ese tablero ya no existe. Puede que se haya eliminado.",
  },
  header: {
    voiceTitle: "Tablero de Voz",
    voiceSubtitle:
      "Habla con tus notas y tareas. Dicta notas, crea acciones pendientes y asigna tareas por voz en tiempo real.",
    c4Title: "Modelo de Arquitectura C4",
    c4Subtitle:
      "Diseña sistemas de software, contenedores, componentes y personas por voz y con un grafo visual.",
    switchWorkspace: "Cambiar de esquema de espacio de trabajo",
    signedInAs: (actor) => `Has iniciado sesión como ${actor}`,
  },
  stage: {
    aria: "Voz",
    tapToTalk: "Toca para hablar",
    tapToStop: "Toca para parar",
    gettingReady: "Preparando…",
    conversationAria: "Conversación",
    voiceSuggestions: [
      "«Crea una nota llamada Compras»",
      "«Añade la tarea: Arreglar el corte de audio con prioridad alta»",
      "«Marca la tarea Ship WebRTC reconnection como hecha»",
      "«¿Qué tareas hay en el tablero?»",
    ],
    c4Suggestions: [
      "«Añade el contenedor Web App con tecnología React al sistema principal»",
      "«Añade el contenedor API Gateway con tecnología Go»",
      "«Conecta Web App con API Gateway usando HTTPS / REST»",
    ],
  },
  caption: {
    idle: "Cuando quieras",
    connecting: "Conectando…",
    listening: "Te escucho — adelante",
    thinking: "Pensando…",
    speaking: "Hablando…",
    error: "Algo ha salido mal",
  },
  speaker: { you: "Tú", agent: "Echo" },
  mic: {
    denied: "Sin acceso al micrófono. Permítelo en tu navegador y vuelve a tocar.",
    missing: "No se ha encontrado ningún micrófono. Conecta uno y vuelve a tocar.",
    failed: "No se ha podido iniciar el micrófono. Toca para intentarlo de nuevo.",
  },
  board: {
    aria: "Tablero",
    notes: "Notas",
    tasks: "Tareas",
    people: "Personas",
    allNotes: "← Todas las notas",
    untitled: "Sin título",
    emptyNote: "Nota vacía",
    newNote: "Nota nueva",
    newNotePrompt: "¿Cómo se debería llamar esta nota?",
    untitledTask: "Tarea sin título",
    toggleCompletion: "Marcar como hecha o pendiente",
    changeStatus: "Haz clic para cambiar el estado",
    fromNote: "Generada a partir de una nota",
    addTask: "Añadir tarea nueva",
    taskTitlePrompt: "Título de la tarea:",
    priorityPrompt: "Prioridad (low, medium, high):",
    unnamed: "Sin nombre",
    taskFallback: "Tarea",
    noteCount: (count) => `${count} notas`,
    taskCount: (count) => `${count} tareas`,
    removePerson: (name) => `Eliminar a ${name}`,
    confirmRemovePerson: (name) =>
      `¿Eliminar a ${name} del tablero? Se desvincularán las tareas que tenga asignadas.`,
    addPerson: "Añadir persona",
    personNamePrompt: "Nombre de la persona (ej. Grace, Alan, Turing):",
    status: { todo: "pendiente", doing: "en curso", done: "hecha" },
    priority: { low: "baja", medium: "media", high: "alta" },
  },
  c4: {
    aria: "Arquitectura C4",
    allElements: "Todos los elementos",
    systemsAndPeople: "Sistemas y personas",
    containers: "Contenedores",
    components: "Componentes",
    addElement: "+ Añadir elemento",
    empty: "No hay elementos en esta categoría.",
    unnamed: "Sin nombre",
    node: "Nodo",
    uses: "usa →",
    contains: "contiene ↳",
    typePrompt: "Tipo de elemento (SoftwareSystem, Container, Component, Person):",
    namePrompt: "Nombre:",
    descriptionPrompt: "Descripción:",
    technologyPrompt: "Tecnología (ej. TypeScript, React, PostgreSQL):",
  },
  dev: {
    summary: "Vista de desarrollo",
    checking: "Comprobando…",
    graphCaption: "Grafo en vivo — nodos y aristas CRDT renderizados en tiempo real.",
    toolCallsCaption: "Llamadas a herramientas",
    toolCallsAria: "Llamadas a herramientas",
    ready: (model, voice, tools, mcp) =>
      `${model} · voz ${voice} · ${tools} herramientas de grafo · MCP en ${mcp}`,
    notConfigured:
      "Voice Live no está configurado. Define AZURE_VOICE_LIVE_ENDPOINT y AZURE_VOICE_LIVE_API_KEY en examples/voice-board/.env y reinicia.",
  },
  voice: {
    notSetUp: "La voz todavía no está configurada.",
    needsKeys:
      "La voz todavía no está configurada — quien la instaló tiene que añadir las claves de Azure.",
    unreachable: "No se ha podido contactar con el servidor.",
    writeFailed: "Eso no se ha guardado. Prueba a decirlo otra vez.",
  },
  tool: {
    savedNote: (subject) => (subject ? `Nota ${subject} guardada` : "Nota guardada"),
    createdTask: (subject) => (subject ? `Tarea ${subject} creada` : "Tarea creada"),
    addedContainer: (subject) =>
      subject ? `Contenedor ${subject} añadido` : "Contenedor añadido",
    addedComponent: (subject) => (subject ? `Componente ${subject} añadido` : "Componente añadido"),
    definedSystem: (subject) => (subject ? `Sistema ${subject} definido` : "Sistema de software definido"),
    addedPerson: (subject) => (subject ? `${subject} añadida` : "Persona añadida"),
    linkedAuthor: "Nota enlazada con su autor",
    assignedTask: "Tarea asignada a un miembro del equipo",
    linkedTaskToNote: "Tarea enlazada con su nota de origen",
    connectedDependency: "Relación de dependencia conectada",
    nestedComponent: "Componente anidado dentro del contenedor/sistema",
    opened: (subject) => (subject ? `${subject} abierto` : "Elemento abierto"),
    checkedArchitecture: "Elementos de arquitectura conectados consultados",
    searched: "Búsqueda en el espacio de trabajo",
  },
  persona: {
    voiceBoard: [
      "Eres Echo, un asistente de notas y tareas en un tablero colaborativo.",
      "El usuario te habla en voz alta mientras mira el tablero en un navegador.",
      "Dicta notas, crea tareas, asigna trabajo y busca por voz.",
      "Habla en una o dos frases cortas. Confirma lo que has cambiado.",
      "Responde siempre en español, aunque los nombres de los nodos estén en inglés.",
    ].join(" "),
    c4: [
      "Eres Echo, un asistente de arquitectura de software que ayuda a diseñar y explorar modelos de arquitectura C4 (Sistemas, Contenedores, Componentes y Usuarios).",
      "El usuario te habla en voz alta mientras mira el grafo en vivo en un navegador.",
      "Usa las herramientas de grafo C4 para todas las acciones: add_container, add_component, upsert_edge_USES, graph_search y graph_get.",
      "Habla en una o dos frases cortas. Confirma lo que has añadido o conectado.",
      "Responde siempre en español, aunque los nombres de los nodos estén en inglés.",
    ].join(" "),
  },
};

const CATALOG: Record<UiLanguage, UiStrings> = { en: EN, es: ES };

/**
 * Narrow anything a browser, a query string, or an `Accept-Language` header
 * might hand us down to a language this app has strings for. `es-419` and
 * `es-MX` are Spanish; everything unrecognized falls back to English rather
 * than rendering a half-translated page.
 */
export function uiLanguage(value?: string | null): UiLanguage {
  const code = value?.toLowerCase().trim().split(",")[0]?.split("-")[0];
  return code && (SUPPORTED_UI_LANGUAGES as readonly string[]).includes(code)
    ? (code as UiLanguage)
    : "en";
}

export function strings(value?: string | null): UiStrings {
  return CATALOG[uiLanguage(value)];
}
