import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/html.ts";

describe("escapeHtml", () => {
  it("encodes markup and quotes so values are safe in HTML text and attributes", () => {
    expect(escapeHtml(`<img src=x onerror="alert('xss')"> & more`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;xss&#39;)&quot;&gt; &amp; more",
    );
  });
});
