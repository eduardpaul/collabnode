import type { CollabGraph } from "@collabnode/graph-view";

/**
 * `<collab-graph>` is a custom element, so JSX has to be told it exists — and
 * told that its `ref` is the element itself, which is what the app assigns a
 * live `session` to.
 */
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "collab-graph": React.DetailedHTMLProps<
        React.HTMLAttributes<CollabGraph> & {
          toolbar?: string;
          inspector?: string;
          editable?: string;
        },
        CollabGraph
      >;
    }
  }
}
