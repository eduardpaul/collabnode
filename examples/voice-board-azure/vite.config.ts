import { defineConfig } from "vite";

export default defineConfig({
  optimizeDeps: {
    // Only this example's own dependencies belong here. The browser also pulls
    // in fluid-framework, yjs, @hocuspocus/provider, and vis-network, but those
    // belong to the linked workspace packages — under pnpm they do not resolve
    // from this directory, so listing them only produced "Failed to resolve
    // dependency" on every boot. Vite discovers and pre-bundles them through
    // the workspace packages on its own; both backends and the graph view are
    // verified working without the entries.
    include: [
      "codemirror",
      "@codemirror/lang-markdown",
      "@codemirror/state",
      "@codemirror/view",
    ],
  },
  define: {
    global: "globalThis",
  },
});
