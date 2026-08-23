import { describe, it, expect } from "vitest";
import {
  useCollab,
  useCollabSnapshot,
  useCollabNodes,
  useCollabNode,
  useCollabEdges,
  useCollabPresence,
  useCollabBatch,
  useCollabNodeState,
  CollabProvider,
  useCollabContext,
} from "../src/index.ts";

describe("@collabnode/react", () => {
  it("exports reactive hooks and context providers", () => {
    expect(typeof useCollab).toBe("function");
    expect(typeof useCollabSnapshot).toBe("function");
    expect(typeof useCollabNodes).toBe("function");
    expect(typeof useCollabNode).toBe("function");
    expect(typeof useCollabEdges).toBe("function");
    expect(typeof useCollabPresence).toBe("function");
    expect(typeof useCollabBatch).toBe("function");
    expect(typeof useCollabNodeState).toBe("function");
    expect(typeof CollabProvider).toBe("function");
    expect(typeof useCollabContext).toBe("function");
  });
});
