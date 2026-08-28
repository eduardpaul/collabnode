/**
 * The dev-server half of `collabnode types`: regenerate a workspace's types
 * whenever its YAML changes, so nobody has to run the CLI by hand.
 */
export { collabnodeTypes } from "@collabnode/schema/vite";
export type { CollabnodeTypesOptions, CollabnodeTypesPlugin } from "@collabnode/schema/vite";
