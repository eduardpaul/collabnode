import type { CollabGraph } from "@collabnode/graph-view";
import type { CollabMermaid } from "./mermaid/element.ts";

/**
 * Graph web components: JSX has to be told they exist — and that `ref` is the
 * element itself, which is what the app assigns a live `session` to.
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
      "collab-mermaid": React.DetailedHTMLProps<
        React.HTMLAttributes<CollabMermaid> & {
          "visible-types"?: string;
          direction?: string;
          theme?: string;
          kind?: string;
        },
        CollabMermaid
      >;
    }
  }
}
