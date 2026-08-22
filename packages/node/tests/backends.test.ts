import { afterEach, describe, expect, it, vi } from "vitest";

const ensureTinylicious = vi.fn(async () => ({ pid: 99, kill: vi.fn() }));
const releaseTinylicious = vi.fn();
const stopTinylicious = vi.fn();

vi.mock("@collabnode/fluid/node", () => ({
  ensureTinylicious: (...args: unknown[]) => ensureTinylicious(...args),
  releaseTinylicious: (...args: unknown[]) => releaseTinylicious(...args),
  stopTinylicious: (...args: unknown[]) => stopTinylicious(...args),
}));

vi.mock("@collabnode/fluid", () => ({
  FluidCollabBackend: class FluidCollabBackend {
    readonly kind = "fluid";
  },
}));

import { InMemoryCollabBackend } from "@collabnode/collab";
import { openCollab } from "../src/backends.ts";

describe("openCollab", () => {
  afterEach(() => {
    ensureTinylicious.mockClear();
    releaseTinylicious.mockClear();
    stopTinylicious.mockClear();
  });

  it("passes storageDir to ensureTinylicious", async () => {
    const opened = await openCollab({ kind: "fluid", storageDir: "data/tinylicious" }, "server");
    expect(ensureTinylicious).toHaveBeenCalledWith(7070, { storageDir: "data/tinylicious" });
    expect(opened.join).toEqual({
      kind: "fluid",
      relay: "tinylicious",
      domain: "http://localhost",
      port: 7070,
    });
    expect(opened.backend.kind).toBe("fluid");
    opened.close();
    expect(releaseTinylicious).toHaveBeenCalledWith(7070);
    expect(stopTinylicious).not.toHaveBeenCalled();
  });

  it("close() is idempotent and does not extra-release while another user remains", async () => {
    const a = await openCollab({ kind: "fluid", port: 7071, storageDir: "data/tinylicious" });
    const b = await openCollab({ kind: "fluid", port: 7071, storageDir: "data/tinylicious" });
    a.close();
    a.close();
    expect(releaseTinylicious).toHaveBeenCalledTimes(1);
    expect(stopTinylicious).not.toHaveBeenCalled();
    b.close();
    expect(releaseTinylicious).toHaveBeenCalledTimes(2);
  });

  it("does not touch Tinylicious for a memory backend", async () => {
    const opened = await openCollab({ kind: "memory" });
    opened.close();
    expect(ensureTinylicious).not.toHaveBeenCalled();
    expect(releaseTinylicious).not.toHaveBeenCalled();
  });

  it("does not touch Tinylicious for a custom backend", async () => {
    const opened = await openCollab({ kind: "custom", backend: new InMemoryCollabBackend() });
    opened.close();
    expect(ensureTinylicious).not.toHaveBeenCalled();
    expect(releaseTinylicious).not.toHaveBeenCalled();
  });
});
