# @collabnode/embeddings

Local text embeddings for [collabnode](https://github.com/eduardpaul/collabnode) semantic search.

Backed by [transformers.js](https://huggingface.co/docs/transformers.js) — no API key, no network after the first run, and nothing leaves the machine.

```bash
npm install @collabnode/embeddings @huggingface/transformers
```

`@huggingface/transformers` is an optional peer dependency: install it only if you enable embeddings.

## Usage

```ts
import { localEmbeddings } from "@collabnode/embeddings";
import { LadybugGraphStore } from "@collabnode/ladybug";

const graph = new LadybugGraphStore({
  path: "data/board.lbdb",
  embeddings: localEmbeddings(),
});
```

The default model is `bge-small-en-v1.5` — 384 dimensions, roughly 30 MB quantized. It downloads on first use and is then cached by transformers.js; loading is lazy and shared, so a process that never embeds never pays for it.

```ts
localEmbeddings({
  model: "Xenova/all-MiniLM-L6-v2",
  pooling: "mean",      // bge/e5 want "cls"; sentence-transformers models want "mean"
  dtype: "q8",          // "fp32" is more faithful, and a much larger download
  minSimilarity: 0.3,   // cosine floor below which a hit counts as unrelated
});
```

## Exports

- `localEmbeddings`, `LocalEmbeddingOptions`
- `EmbeddingProvider` (re-exported from `@collabnode/graph`)

---

Part of [collabnode](https://github.com/eduardpaul/collabnode). Most applications should depend on the top-level [`collabnode`](https://www.npmjs.com/package/collabnode) package instead of wiring this one directly.

MIT © Eduard Paul
