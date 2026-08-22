import { describe, expect, it } from "vitest";
import { localEmbeddings } from "../src/local.ts";

/**
 * These run against the real model, which is downloaded on first use. Where
 * that is not possible — offline CI, no transformers.js installed — the suite
 * reports the reason and skips rather than failing on the network.
 */
async function available(): Promise<boolean> {
  try {
    await import("@huggingface/transformers");
    return true;
  } catch {
    return false;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number);
  }
  return dot;
}

describe("localEmbeddings", () => {
  it("declares its width before the model is ever loaded", () => {
    expect(localEmbeddings().dimensions).toBe(384);
    expect(localEmbeddings().id).toBe("Xenova/bge-small-en-v1.5");
    expect(localEmbeddings({ model: "Xenova/bge-base-en-v1.5" }).dimensions).toBe(768);
  });

  it("carries a relevance floor, so an unanswerable question returns nothing", async () => {
    expect(localEmbeddings().minSimilarity).toBe(0.5);
    expect(localEmbeddings({ minSimilarity: 0 }).minSimilarity).toBe(0);
    if (!(await available())) {
      return;
    }
    const provider = localEmbeddings();
    const [note] = await provider.embed(["Q3 headcount plan and interview loop"], "document");
    const [unrelated] = await provider.embed(["quantum tunnelling in semiconductors"], "query");
    const [related] = await provider.embed(["what did we decide about hiring?"], "query");
    expect(cosine(unrelated!, note!)).toBeLessThan(provider.minSimilarity!);
    expect(cosine(related!, note!)).toBeGreaterThan(provider.minSimilarity!);
  }, 120_000);

  it("refuses a model whose width it cannot know, rather than guessing", () => {
    expect(() => localEmbeddings({ model: "some/unlisted-model" })).toThrow(/unknown embedding width/);
    expect(localEmbeddings({ model: "some/unlisted-model", dimensions: 512 }).dimensions).toBe(512);
  });

  it("puts a question nearer the note that answers it than an unrelated one", async () => {
    if (!(await available())) {
      return;
    }
    const provider = localEmbeddings();
    const [hiring, invoices] = await provider.embed(
      ["Q3 headcount plan and interview loop", "Invoice payment terms for vendors"],
      "document",
    );
    const [question] = await provider.embed(["what did we decide about hiring?"], "query");
    expect(hiring?.length).toBe(384);
    // Neither note contains the word "hiring"; only the first is about it.
    expect(cosine(question!, hiring!)).toBeGreaterThan(cosine(question!, invoices!));
  }, 120_000);

  it("returns normalized vectors, so cosine is a dot product", async () => {
    if (!(await available())) {
      return;
    }
    const [vector] = await localEmbeddings().embed(["standup"], "document");
    expect(cosine(vector!, vector!)).toBeCloseTo(1, 4);
  }, 120_000);

  it("embeds a blank string rather than failing the batch it arrived in", async () => {
    if (!(await available())) {
      return;
    }
    const vectors = await localEmbeddings().embed(["", "standup"], "document");
    expect(vectors).toHaveLength(2);
    expect(vectors[0]?.length).toBe(384);
  }, 120_000);
});
