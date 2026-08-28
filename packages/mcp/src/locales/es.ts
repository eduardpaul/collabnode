import type { McpLocaleCatalog } from "./types.js";

export const ES_CATALOG: McpLocaleCatalog = {
  prompts: {
    systemPromptDescription: (name) => `Prompt de sistema para colaborar en ${name}`,
    agentRoleDescription: (role) => `Prompt de rol para ${role}`,
    agentActingText: (role, documentId) => `Estás actuando como el ${role} en el espacio de trabajo ${documentId}.`,
    workOnDescription: (type) => `Cómo crear o actualizar nodos ${type}`,
    workOnDerivedCallHelp: (toolName) =>
      `Llama a la herramienta \`${toolName}\` con las propiedades editables anteriores. Omite el id a menos que actualices un nodo conocido. No envíes campos derivados; el servidor los calcula.`,
    workOnCallHelp: (toolName) =>
      `Llama a la herramienta \`${toolName}\` con las propiedades anteriores. Omite el id a menos que actualices un nodo conocido.`,
    linkDescription: (type) => `Cómo crear aristas ${type}`,
    linkCallHelp: (toolName) => `Llama a la herramienta \`${toolName}\` con los ids de los nodos from y to.`,
    roleHeader: (role, systemPrompt) => `## Rol: ${role}\n${systemPrompt}\n\n`,
    collaboratingOnWorkspace: (name, documentId) => `Estás colaborando en el espacio de trabajo "${name}" (${documentId}).`,
    collaboratingOnGraph: (name, schemaId, documentId) =>
      `Estás colaborando en el grafo "${name}" (${schemaId}, id: ${documentId}).`,
    activeActor: (actorId) => `Actor activo: ${actorId}`,
    rulesHeader: "## Reglas de colaboración y grafo",
    rules: {
      multiParticipant: "- Múltiples participantes y agentes comparten este espacio de trabajo en tiempo real.",
      preferTargetedReads: "- Prefiere graph_list, graph_get, graph_search y graph_neighbors sobre graph_snapshot.",
      searchBeforeCreate: "- Busca o inspecciona entidades existentes antes de crear nuevas para evitar nodos duplicados.",
      identityMatching:
        "- Para entidades con clave de identidad, los valores de propiedad coincidentes encontrarán y actualizarán el nodo existente automáticamente (omite el ID al crear).",
      tagsSupported: "- Se admiten etiquetas en los nodos. Pasa tags[] para establecer o reemplazar etiquetas; pasa [] para limpiar.",
    },
    nodeTypesHeader: "## Tipos de nodo",
    edgeTypesHeader: "## Tipos de arista",
    none: "(ninguno)",
    identityFields: (fields) => `- Campos de identidad: [${fields}] (los valores coincidentes actualizan el nodo existente)`,
    singleInstance:
      "- Instancia única: un nodo de este tipo por espacio de trabajo. Escribir en él lo actualiza; nunca hay un segundo y no necesita id.",
    propertiesHeader: "- Propiedades:",
    derivedHeader: "- Derivado (solo lectura, calculado por el servidor; no enviar):",
    guidelinesHeader: "- Directrices:",
    edgeConnects: (from, to) => `- Conecta: (${from}) -> (${to})`,
    propertyKeywords: {
      integer: "entero",
      min: (val) => `mín ${val}`,
      max: (val) => `máx ${val}`,
      maxLength: (val) => `longitudMáxima ${val}`,
      required: "requerido",
      default: (val) => `predeterminado: ${val}`,
      derived: (val) => `derivado: ${val} (solo lectura, calculado por el servidor)`,
    },
    promptArgsDescription: "Idioma para el prompt (ej. 'es', 'en', 'spanish', 'english')",
  },
  tools: {
    guidelinesBlurb: (guidelines) => ` Directrices: ${guidelines}`,
    describe:
      "Devuelve el contrato del grafo: tipos, propiedades, claves de identidad, directrices, id del documento y actor. Llama a esto primero si no tienes el prompt graph-system.",
    list: {
      description:
        "Índice compacto de nodos (id, tipo, etiqueta, propiedades clave). Filtra por tipos, etiqueta o subcadena q, con paginación de desplazamiento estable. Usa graph_search en su lugar cuando busques algo por nombre. Prefiere esto sobre graph_snapshot.",
      types: "Restringir a estos tipos de nodo.",
      tag: "Requerir esta etiqueta exacta.",
      q: "Filtro de subcadena opcional, ignorando mayúsculas y puntuación. Es un filtro, no una búsqueda clasificada; los resultados permanecen en orden estable para paginación.",
      limit: "Resultados máximos (por defecto 20, máx 100).",
      offset: "Omitir este número de coincidencias (por defecto 0).",
    },
    get: {
      description:
        "Devuelve un nodo o arista por id (o prefijo de id único), más las aristas incidentes (ids, tipos, etiquetas). Prefiere esto sobre graph_snapshot.",
      id: "Id completo o prefijo único de al menos 4 caracteres.",
    },
    search: {
      description: (modes) => {
        const shared =
          "q es opcional cuando se establecen types o tag. Los valores de cadena en los resultados se truncan a 240 caracteres.";
        if (!modes.text && !modes.vector) {
          return `Encuentra nodos cuyas propiedades o etiquetas contengan q como subcadena. Los resultados están en orden de grafo y no tienen puntuación de relevancia, porque esta proyección no tiene índice de texto completo. ${shared}`;
        }
        if (!modes.vector) {
          return `Búsqueda de texto completo clasificada sobre propiedades indexadas y etiquetas, ejecutada por el propio índice del almacén de grafos. Tolera mayúsculas, acentos, puntuación, orden de palabras y plurales, por lo que 'Stand-Up' encuentra una nota titulada 'Standup'. Mejor coincidencia primero — prefiere esto sobre graph_list cuando busques algo por nombre. ${shared}`;
        }
        return `Búsqueda clasificada por redacción y significado a la vez, ejecutada por los propios índices del almacén de grafos. Redacción: 'Stand-Up' encuentra la nota titulada 'Standup', a través de mayúsculas, acentos, puntuación, orden de palabras y plurales. Significado: 'qué decidimos sobre contrataciones' encuentra notas sobre contrataciones que nunca usan la palabra, así que pregunta con la propia frase del usuario en lugar de adivinar palabras clave. Mejor coincidencia primero, y cada coincidencia indica cómo coincidió: 'text' por redacción, 'vector' por significado, 'both' cuando ambos coinciden. Una coincidencia 'vector' es sobre el tema; no necesariamente se llama así. ${shared}`;
      },
      qVector:
        "Qué buscar, en las propias palabras del usuario. Un nombre o una pregunta completa: se busca tanto por significado como por redacción, por lo que una frase completa funciona mejor aquí que palabras clave. Las coincidencias clasificadas llevan una puntuación y un tipo de coincidencia, la mejor primero; ambas están ausentes cuando la coincidencia provino del respaldo por subcadena.",
      qText:
        "Qué buscar. Se compara con etiquetas, propiedades indexadas y tags; se ignoran mayúsculas, acentos, puntuación y orden de palabras. Las coincidencias clasificadas llevan una puntuación, la mejor primero; la puntuación está ausente cuando la coincidencia provino del respaldo por subcadena.",
      types: "Restringir a estos tipos de nodo.",
      tag: "Requerir esta etiqueta exacta.",
      limit: "Resultados máximos (por defecto 20, máx 100).",
    },
    similar: {
      description:
        "Nodos similares a un nodo dado, clasificados por significado. Toma un id de nodo, no una cadena de búsqueda, así que úsalo para 'más como este', 'notas relacionadas' o para encontrar casi duplicados antes de crear algo nuevo. No devuelve nada sobre el nodo en sí.",
      id: "Id (o prefijo único) del nodo para el cual encontrar vecinos en significado.",
      types: "Restringir a estos tipos de nodo.",
      limit: "Resultados máximos (por defecto 20, máx 100).",
    },
    neighbors: {
      description:
        "Devuelve los vecinos de un nodo. Filtra por edgeTypes y direction (in | out | both). depth es 1 (por defecto) o 2. El recuento de vecinos está limitado (por defecto 100). Las cadenas largas se truncan; usa graph_get para el texto completo.",
      depth: "Profundidad de recorrido: 1 (por defecto) o 2.",
      limit: "Vecinos máximos (por defecto 100, máx 100).",
    },
    snapshot: {
      description:
        "Devuelve el grafo colaborativo. Prefiere graph_list / graph_get / graph_search / graph_neighbors. Filtra por tipos de nodo/arista. includeText es false por defecto y reemplaza cadenas largas con {truncated, length}.",
      types: "Tipos de nodo y/o arista a incluir.",
      includeText:
        "Cuando es false (por defecto), los valores de cadena de más de 240 caracteres se convierten en {truncated: true, length}.",
    },
    query: {
      description: (graphKind, exampleType) => {
        const example = `Ejemplo: MATCH (n:${exampleType}) RETURN n. Las escrituras deben usar herramientas upsert/delete.`;
        if (graphKind === "ladybug") {
          return `Ejecuta una consulta Cypher de solo lectura contra la proyección Ladybug. ${example}`;
        }
        if (graphKind === "age") {
          return `Ejecuta openCypher de solo lectura contra la proyección Apache AGE. ${example}`;
        }
        return `Ejecuta una consulta de grafo de solo lectura contra la proyección local. El almacén en memoria solo admite \`MATCH (n:Type) RETURN n\` y \`MATCH (a)-[r:TYPE]->(b) RETURN ...\`. ${example}`;
      },
      cypher: "Consulta MATCH/RETURN de solo lectura. CREATE/MERGE/SET/DELETE se rechazan.",
      params: "Parámetros opcionales de la consulta.",
      limit: "Filas máximas (por defecto 50, máx 100).",
    },
    history: {
      description:
        "Devuelve el registro persistente de seguimiento de cambios. Vacío a menos que config.changeTracking.mode sea history. Filtra por id de entidad, actorId, since (ISO) y limit.",
      limit: "Entradas máximas (por defecto 50, máx 100).",
    },
    changes: {
      description:
        "Devuelve escrituras recientes. Usa el registro de historial cuando changeTracking.mode es history; de lo contrario, marcas de metadatos de última escritura (se omiten eliminaciones). Pasa el cursor devuelto como since en la siguiente llamada.",
      since: "Marca de tiempo ISO-8601; devuelve escrituras en o después de este tiempo.",
      limit: "Eventos máximos (por defecto 50, máx 100).",
    },
    actors: "Lista los actores que han creado o actualizado nodos/aristas en este documento (a partir de marcas de metadatos).",
    deleteNode: "Elimina un nodo y sus aristas incidentes del grafo compartido. Falla si el id no existe.",
    deleteEdge: "Elimina una arista del grafo compartido. Falla si el id no existe.",
    applyBatch: {
      description:
        "Aplica varias escrituras de nodos y aristas como un único lote atómico. Usa ref para apuntar una arista a un nodo creado en el mismo lote. Cada operación está sujeta a las mismas reglas de escritura que las herramientas individuales.",
      ops: "Operaciones en orden: {op: 'upsertNode', type, ref?, id?, properties?, tags?}, {op: 'upsertEdge', type, from, to, properties?}, {op: 'deleteNode', id}, {op: 'deleteEdge', id}.",
    },
    diffSince: {
      description:
        "Compara una instantánea tomada antes con el grafo actual y devuelve qué cambió, como operaciones y como Markdown legible.",
      previousSnapshot: "Un GraphSnapshot devuelto por una llamada anterior a graph_snapshot.",
    },
    upsertNode: (type, description, guidelinesBlurb) => {
      const descPart = description ? ` ${description}` : "";
      return `Crea o actualiza un nodo ${type}.${descPart}${guidelinesBlurb}`;
    },
    upsertSingletonNode: (type, description, guidelinesBlurb) => {
      const descPart = description ? ` ${description}` : "";
      return `Actualiza el nodo ${type}. Hay exactamente uno por espacio de trabajo, creado en la primera escritura, así que esto nunca crea un segundo y no admite id. Envía solo las propiedades que cambias.${descPart}${guidelinesBlurb}`;
    },
    upsertEdge: (type, from, to, description, guidelinesBlurb) => {
      const descPart = description ? ` ${description}` : "";
      return `Crea o actualiza una arista ${type} de ${from} a ${to}.${descPart} Reutiliza una arista existente con los mismos extremos a menos que se establezca id.${guidelinesBlurb}`;
    },
    namedTool: (name) => `Herramienta con nombre ${name}`,
    view: {
      description: (name, description, guidanceBlurb) =>
        `Vista '${name}'. Devuelve una porción del grafo en Markdown.${
          description ? ` ${description}` : ""
        }${guidanceBlurb}`,
      guidanceBlurb: (guidance) => ` Qué revisar: ${guidance}`,
    },
    nodeRef: {
      idOrPrefix: "Id del nodo o prefijo de id único (mínimo 4 caracteres).",
      identityObject: "Objeto de identidad, ej. { type: 'Task', title: 'Ship' } o { id: '...' }.",
    },
    plan: {
      nodeRef:
        "Un identificador corto para este nodo, único dentro de este plan (p. ej. \"epic-1\"). Las aristas lo referencian por este valor. Nunca se escribe en el grafo.",
      nodeId:
        "El id de un nodo existente que esta entrada actualiza. Null al crear un nodo nuevo. Nunca un título.",
      endpoint:
        "El `id` de un nodo que ya existe en el grafo, o el `ref` de un nodo creado en este plan. Nunca un título.",
      nodes: "Nodos a crear o actualizar. Da un `ref` a cada uno para que las aristas puedan apuntarlo.",
      edges:
        "Todas las relaciones de este plan. La estructura vive aquí y en ningún otro sitio: nunca pongas el id o el título del padre en las propiedades de un nodo.",
      relationshipsAreEdges:
        "Las relaciones con otros nodos van en `edges`, no en estas propiedades.",
      numberRange: (min, max) => {
        if (min !== undefined && max !== undefined) return `De ${min} a ${max}.`;
        return min !== undefined ? `${min} o más.` : `${max} o menos.`;
      },
      maxLength: (max) => `Máximo ${max} caracteres.`,
    },
    nodeUpsert: {
      id: "Id de nodo existente. Omitir al crear; los tipos con clave de identidad buscan o actualizan a partir de los campos de identidad. Los ids aleatorios se ignoran cuando los campos de identidad coinciden con un nodo existente.",
      tags: "Reemplaza el conjunto de etiquetas. Omitir para dejar las etiquetas existentes; pasa [] para limpiar.",
      missingRequiredProperty: (propName) => `falta la propiedad requerida '${propName}'`,
    },
    edgeUpsert: {
      from: (types) => `Nodo origen (${types}): id, prefijo único o { type, ...identity }`,
      to: (types) => `Nodo destino (${types}): id, prefijo único o { type, ...identity }`,
    },
    namedToolInput: {
      id: (type) => `Id opcional del nodo ${type} (generado si se omite).`,
      tags: "Etiquetas opcionales.",
      intoParent: (intoType, toTypes) =>
        `Id del nodo padre de destino (o prefijo único) para conectar mediante ${intoType} (${toTypes}).`,
    },
    policy: {
      readOnlyNodeType: (type) =>
        `Los nodos ${type} son de solo lectura para este rol de agente: se pueden leer, pero no crear, actualizar ni eliminar.`,
      readOnlyEdgeType: (type) =>
        `Las aristas ${type} son de solo lectura para este rol de agente: conectarlas o desconectarlas cambiaría cómo se leen sus extremos para todos los demás.`,
      unknownBatchOp: (op) =>
        `Operación de lote desconocida '${op}'. Usa upsertNode, upsertEdge, deleteNode o deleteEdge.`,
    },
    propertyDescriptions: {
      datetime: "Fecha y hora ISO-8601",
      datetimeWithDesc: (desc) => `${desc} (fecha y hora ISO-8601)`,
      textWithDesc: (desc) =>
        `${desc}. Pasa el texto completo aquí; escribirlo solo en el chat no lo almacena.`,
      textDefault: "Contenido de texto completo. Pásalo en este campo; escribirlo solo en el chat no lo almacena.",
    },
  },
  resources: {
    schema: (name) => `GraphSchema derivado de YAML para ${name}`,
    snapshot:
      "Instancia de grafo colaborativo en vivo con cadenas largas truncadas. Usa graph_get o graph_snapshot({ includeText: true }) para el texto completo.",
    nodeGuidelines: (type) => `Directrices del agente para el tipo de nodo ${type}`,
    edgeGuidelines: (type) => `Directrices del agente para el tipo de arista ${type}`,
  },
};
