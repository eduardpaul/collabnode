import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollabSession } from "@collabnode/runtime";
import type { GraphSnapshot } from "@collabnode/graph";

/**
 * What `connect()` returns, faked.
 *
 * The point of these tests is the *lifecycle* around a connection — is it
 * closed, is its change subscription released — so the connection itself is a
 * record of what was asked of it rather than a real relay.
 */
const state = vi.hoisted(() => ({
  opened: [] as string[],
  closed: [] as string[],
  subscribed: 0,
  unsubscribed: 0,
  connectFails: false,
}));

function fakeSession(documentId: string): CollabSession {
  const snapshot: GraphSnapshot = { schemaId: "s", schemaHash: "h", nodes: [], edges: [] };
  return {
    id: documentId,
    snapshot: () => snapshot,
    onChange: () => {
      state.subscribed += 1;
      return () => {
        state.unsubscribed += 1;
      };
    },
  } as unknown as CollabSession;
}

vi.mock("@collabnode/web", () => ({
  connect: vi.fn(async (options: { documentId: string }) => {
    if (state.connectFails) {
      throw new Error("relay unreachable");
    }
    state.opened.push(options.documentId);
    return {
      session: fakeSession(options.documentId),
      schema: {},
      documentId: options.documentId,
      close: async () => {
        state.closed.push(options.documentId);
      },
    };
  }),
}));

const { useCollab, useCollabSnapshot } = await import("../src/index.ts");

let container: HTMLDivElement;
let root: Root;

function mount(element: ReturnType<typeof createElement>): void {
  act(() => {
    root.render(element);
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
}

/** A component that does nothing but hold a connection. */
function Holder({ documentId }: { documentId: string | null }): null {
  useCollab(
    documentId
      ? { documentId, schema: { name: "s" } as never, collab: { kind: "memory" } as never }
      : null,
  );
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.opened = [];
  state.closed = [];
  state.subscribed = 0;
  state.unsubscribed = 0;
  state.connectFails = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  container.remove();
});

describe("useCollab lifecycle", () => {
  it("closes the connection it opened when the component unmounts", async () => {
    mount(createElement(Holder, { documentId: "doc-1" }));
    await act(async () => {});
    expect(state.opened).toEqual(["doc-1"]);
    expect(state.closed).toEqual([]);

    unmount();
    await act(async () => {});
    expect(state.closed).toEqual(["doc-1"]);
  });

  it("closes the old connection when it is pointed at another document", async () => {
    mount(createElement(Holder, { documentId: "doc-1" }));
    await act(async () => {});

    mount(createElement(Holder, { documentId: "doc-2" }));
    await act(async () => {});

    expect(state.opened).toEqual(["doc-1", "doc-2"]);
    expect(state.closed).toEqual(["doc-1"]);

    unmount();
    await act(async () => {});
    expect(state.closed).toEqual(["doc-1", "doc-2"]);
  });

  it("closes a connection that arrives after the component is gone", async () => {
    mount(createElement(Holder, { documentId: "doc-1" }));
    // Unmount in the same tick, before `connect()` has resolved.
    unmount();
    await act(async () => {});
    expect(state.closed).toEqual(["doc-1"]);
  });

  it("reports a failed connection without leaving isLoading set", async () => {
    state.connectFails = true;
    let seen: { error: Error | null; isLoading: boolean } | undefined;
    function Reader(): null {
      const { error, isLoading } = useCollab({
        documentId: "doc-1",
        schema: { name: "s" } as never,
        collab: { kind: "memory" } as never,
      });
      seen = { error, isLoading };
      return null;
    }
    mount(createElement(Reader));
    await act(async () => {});
    expect(seen?.error?.message).toBe("relay unreachable");
    expect(seen?.isLoading).toBe(false);
    unmount();
  });
});

describe("useCollabSnapshot subscriptions", () => {
  it("releases the session subscription when the last reader unmounts", async () => {
    const session = fakeSession("doc-1");
    function Reader(): null {
      useCollabSnapshot(session);
      return null;
    }

    mount(createElement("div", null, createElement(Reader), createElement(Reader)));
    await act(async () => {});
    // Two readers, one subscription on the session.
    expect(state.subscribed).toBe(1);
    expect(state.unsubscribed).toBe(0);

    unmount();
    await act(async () => {});
    expect(state.unsubscribed).toBe(1);
  });
});
