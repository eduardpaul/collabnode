/**
 * Validates that "Spanish" reaches every layer a caller actually sees, not
 * just the page chrome:
 *
 *   1. the workspace YAML resolves its `es:` keys, and falls back to English
 *      for a language it has no text for;
 *   2. the generated MCP tool catalog is Spanish — both the built-in wording
 *      from the locale catalog and the per-type wording from the YAML;
 *   3. the system prompt handed to the voice agent is Spanish;
 *   4. tool *names* and enum *values* stay untranslated, because they are the
 *      wire protocol shared by an English tab and a Spanish tab on one graph.
 */
import assert from "node:assert/strict";
import {
  CollabSession,
  InMemoryCollabBackend,
  InMemoryGraphStore,
  buildTools,
  guidelinesFor,
  loadWorkspaceTypeFile,
  resolveGuidelines,
  resolveI18nString,
  systemPromptText,
} from "collabnode";
import { strings, uiLanguage, SUPPORTED_UI_LANGUAGES } from "./i18n.ts";
import { defaultVoice } from "./env.ts";

const voiceBoard = await loadWorkspaceTypeFile(
  new URL("../workspaces/voice-board.yaml", import.meta.url).pathname,
);
const c4 = await loadWorkspaceTypeFile(
  new URL("../workspaces/c4-architecture.yaml", import.meta.url).pathname,
);

// ---------------------------------------------------------------- 1. schema
for (const type of [voiceBoard, c4]) {
  const label = type.name;

  const es = resolveI18nString(type.description, "es");
  const en = resolveI18nString(type.description, "en");
  assert.ok(es && en, `${label}: description missing a translation`);
  assert.notEqual(es, en, `${label}: description is not actually translated`);

  // A regional subtag is still Spanish; an unknown language falls back to
  // English rather than to whichever key happens to be first in the file.
  assert.equal(resolveI18nString(type.description, "es-MX"), es);
  assert.equal(resolveI18nString(type.description, "de"), en);
  assert.equal(resolveI18nString(type.description), en);

  assert.notEqual(
    resolveI18nString(type.schema.config.display?.title, "es"),
    resolveI18nString(type.schema.config.display?.title, "en"),
    `${label}: display title is not translated`,
  );

  // Every node and edge type carries both languages, so no half-Spanish
  // contract can reach the model.
  for (const [name, def] of Object.entries(type.schema.nodes)) {
    assert.ok(resolveI18nString(def.description, "es"), `${label}.${name}: no Spanish description`);
    assert.notEqual(
      resolveI18nString(def.description, "es"),
      resolveI18nString(def.description, "en"),
      `${label}.${name}: description is not translated`,
    );
    const guidesEs = resolveGuidelines(def.guidelines, "es");
    const guidesEn = resolveGuidelines(def.guidelines, "en");
    assert.equal(guidesEs.length, guidesEn.length, `${label}.${name}: guideline count differs`);
    assert.ok(guidesEs.length > 0, `${label}.${name}: no guidelines`);
    assert.notDeepEqual(guidesEs, guidesEn, `${label}.${name}: guidelines are not translated`);
  }
  for (const [name, def] of Object.entries(type.schema.edges)) {
    assert.notEqual(
      resolveI18nString(def.description, "es"),
      resolveI18nString(def.description, "en"),
      `${label}.${name}: edge description is not translated`,
    );
    assert.notEqual(
      resolveI18nString(def.ui?.label, "es"),
      resolveI18nString(def.ui?.label, "en"),
      `${label}.${name}: edge label is not translated`,
    );
  }

  // Named tools and agents are what the voice model is handed directly.
  for (const [name, def] of Object.entries(type.tools?.named ?? {})) {
    assert.notEqual(
      resolveI18nString(def.description, "es"),
      resolveI18nString(def.description, "en"),
      `${label}: named tool ${name} is not translated`,
    );
  }
  for (const agent of type.tools?.agents ?? []) {
    assert.ok(
      resolveI18nString(agent.systemPrompt, "es"),
      `${label}: agent ${agent.role} has no Spanish system prompt`,
    );
  }
}

// `guidelinesFor` is the schema-level accessor the runtime and graph view use.
assert.deepEqual(
  guidelinesFor(voiceBoard.schema, "node", "Note", "es"),
  resolveGuidelines(voiceBoard.schema.nodes.Note!.guidelines, "es"),
);
assert.equal(guidelinesFor(voiceBoard.schema, "node", "Note", "es")[0], "Los títulos son cortos");
assert.equal(guidelinesFor(voiceBoard.schema, "node", "Note", "en")[0], "Titles are short");

// --------------------------------------------------------------- 2. tools
const session = await CollabSession.open("voice-i18n-test", {
  schema: voiceBoard.schema,
  actorId: "tester",
  collab: new InMemoryCollabBackend(),
  graph: new InMemoryGraphStore(),
});

const toolsEs = buildTools(voiceBoard.schema, session, { graphKind: "memory", language: "es" });
const toolsEn = buildTools(voiceBoard.schema, session, { graphKind: "memory", language: "en" });

assert.deepEqual(
  toolsEs.map((tool) => tool.name),
  toolsEn.map((tool) => tool.name),
  "tool names must not change with language",
);

const byName = (tools: typeof toolsEs, name: string) => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
};

// Built-in wording comes from the MCP locale catalog...
assert.match(byName(toolsEs, "graph_search").description, /B[úu]squeda de texto completo/);
assert.match(byName(toolsEn, "graph_search").description, /[Ss]earch/);

// ...and the per-type half comes from the workspace YAML, guidelines included.
const upsertNoteEs = byName(toolsEs, "upsert_node_Note").description;
assert.match(upsertNoteEs, /Una nota markdown colaborativa/);
assert.match(upsertNoteEs, /Los títulos son cortos/);
assert.doesNotMatch(upsertNoteEs, /Titles are short/);

const upsertNoteEn = byName(toolsEn, "upsert_node_Note").description;
assert.match(upsertNoteEn, /A collaborative markdown note/);
assert.match(upsertNoteEn, /Titles are short/);

// Edge descriptions reach the tool description too.
assert.match(byName(toolsEs, "upsert_edge_AUTHORED").description, /La persona que dictó/);
assert.match(byName(toolsEn, "upsert_edge_AUTHORED").description, /The person who dictated/);

// Every generated tool must actually differ, or some layer is still English.
for (const tool of toolsEs) {
  const english = byName(toolsEn, tool.name);
  if (tool.name.startsWith("upsert_")) {
    assert.notEqual(tool.description, english.description, `${tool.name} is not translated`);
  }
}

// ------------------------------------------------------------- 3. prompts
const promptEs = systemPromptText(
  voiceBoard.schema,
  { documentId: "voice-board-1", actorId: "echo", type: voiceBoard, agentRole: "voice-live" },
  "es",
);
const promptEn = systemPromptText(
  voiceBoard.schema,
  { documentId: "voice-board-1", actorId: "echo", type: voiceBoard, agentRole: "voice-live" },
  "en",
);
assert.notEqual(promptEs, promptEn);
assert.match(promptEs, /Responde siempre en español/);
assert.match(promptEs, /Los títulos son cortos/);
assert.doesNotMatch(promptEs, /Titles are short/);
assert.match(promptEn, /Titles are short/);

// The C4 workspace runs the same path with its own agent.
const c4PromptEs = systemPromptText(
  c4.schema,
  { documentId: "c4-architecture-1", actorId: "echo", type: c4, agentRole: "c4-architect" },
  "es",
);
assert.match(c4PromptEs, /Arquitectura de Software C4/);
assert.doesNotMatch(c4PromptEs, /Represents a standalone software system/);

// The block `handleOffer` hands Voice Live is persona + generated contract.
// Assembling it here keeps the two halves from drifting into different
// languages, which is what makes an agent answer English to a Spanish question.
for (const [language, marker] of [["es", /Responde siempre en español/], ["en", /Speak in one or two short sentences/]] as const) {
  const instructions = [
    strings(language).persona.voiceBoard,
    systemPromptText(
      voiceBoard.schema,
      { documentId: "voice-board-1", actorId: "echo", type: voiceBoard, agentRole: "voice-live" },
      language,
    ),
  ].join("\n\n");
  assert.match(instructions, marker, `${language}: persona missing from instructions`);
  assert.match(
    instructions,
    language === "es" ? /Los títulos son cortos/ : /Titles are short/,
    `${language}: schema guidelines missing from instructions`,
  );
}

// -------------------------------------------------- 4. protocol stays put
// Enum values are what get written to the graph, so a Spanish tab and an
// English tab must agree on them even though the badges read differently.
assert.deepEqual(voiceBoard.schema.nodes.Task!.properties.status!.values, ["todo", "doing", "done"]);
assert.equal(strings("es").board.status.done, "hecha");
assert.equal(strings("en").board.status.done, "done");

// ------------------------------------------------------------ 5. UI shell
assert.equal(uiLanguage("es"), "es");
assert.equal(uiLanguage("es-419"), "es");
assert.equal(uiLanguage("es-MX,es;q=0.9,en;q=0.8"), "es");
assert.equal(uiLanguage("de"), "en", "an unsupported language falls back to English");
assert.equal(uiLanguage(undefined), "en");
assert.equal(uiLanguage(""), "en");

// Both catalogs must have the same shape, or a language switch renders
// `undefined` somewhere in the page.
function shape(value: unknown, path = ""): string[] {
  if (typeof value === "function") {
    return [`${path}:fn`];
  }
  if (Array.isArray(value)) {
    return [`${path}:array`];
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .flatMap((key) => shape((value as Record<string, unknown>)[key], `${path}.${key}`));
  }
  return [`${path}:${typeof value}`];
}
assert.deepEqual(shape(strings("es")), shape(strings("en")), "catalogs have diverged");

for (const language of SUPPORTED_UI_LANGUAGES) {
  const t = strings(language);
  for (const [key, value] of Object.entries(t.caption)) {
    assert.ok(value.trim().length > 0, `${language}.caption.${key} is empty`);
  }
  assert.equal(t.htmlLang, language);
}

// Spanish gets a Spanish TTS voice, unless the operator pinned one in .env.
assert.equal(defaultVoice("gpt-realtime", "es"), "es-ES-ElviraNeural");
assert.equal(defaultVoice("gpt-realtime", "en"), "en-US-AvaNeural");
assert.equal(defaultVoice("gpt-realtime"), "en-US-AvaNeural");
// `azure-realtime` takes native voice names, which are not per-locale.
assert.equal(defaultVoice("azure-realtime", "es"), "ava");

await session.close();
console.log("voice-i18n.test.ts ok: Spanish resolves through schema, tools, prompts, and UI");
