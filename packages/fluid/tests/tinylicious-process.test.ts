import { afterEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { openPorts, spawnMock, spawnSyncMock, fakeKill } = vi.hoisted(() => {
  const openPorts = new Set<number>();
  const fakeKill = vi.fn();
  let nextPid = 4242;
  const spawnMock = vi.fn((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const port = Number(opts?.env?.PORT);
    if (Number.isFinite(port)) {
      openPorts.add(port);
    }
    return {
      pid: nextPid++,
      stdout: null,
      stderr: null,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      kill: fakeKill,
    };
  });
  const spawnSyncMock = vi.fn();
  return { openPorts, spawnMock, spawnSyncMock, fakeKill };
});

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

vi.mock("node:net", () => ({
  createConnection: vi.fn((opts: { port: number; host: string }, onConnect?: () => void) => {
    const socket = {
      end: vi.fn(),
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "error" && !openPorts.has(opts.port)) {
          queueMicrotask(handler);
        }
        return socket;
      }),
    };
    if (openPorts.has(opts.port)) {
      queueMicrotask(() => onConnect?.());
    }
    return socket;
  }),
}));

import {
  ensureTinylicious,
  isStaleTinyliciousLog,
  releaseTinylicious,
  resetTinyliciousLeases,
  tinyliciousSpawnEnv,
} from "../src/tinylicious-process.ts";

describe("tinyliciousSpawnEnv", () => {
  it("points Tinylicious at an isolated snapshot dir and quiets winston", () => {
    const env = tinyliciousSpawnEnv(7070, "/tmp/cn-tiny-test", {
      PATH: "/usr/bin",
      TINYLICIOUS_LOG_LEVEL: undefined,
    } as unknown as NodeJS.ProcessEnv);
    expect(env.PORT).toBe("7070");
    expect(env.storage).toBe("/tmp/cn-tiny-test");
    expect(env.logger__level).toBe("error");
  });

  it("keeps TINYLICIOUS_LOG_LEVEL when the operator wants the flood", () => {
    const env = tinyliciousSpawnEnv(7070, "/tmp/x", {
      PATH: "/usr/bin",
      TINYLICIOUS_LOG_LEVEL: "info",
    });
    expect(env.logger__level).toBe("info");
  });
});

describe("isStaleTinyliciousLog", () => {
  it("drops leftover-tab reconnects to a dead documentId", () => {
    expect(
      isStaleTinyliciousLog(
        'error: Could not find heads/272b8e7a-d940-464b-9f01-eab2db08152b. {"code":400}',
      ),
    ).toBe(true);
    expect(isStaleTinyliciousLog('error: Error while fetching summary for tinylicious/abc')).toBe(
      true,
    );
    expect(isStaleTinyliciousLog("Listening on port 7070")).toBe(false);
  });
});

describe("ensureTinylicious", () => {
  afterEach(() => {
    resetTinyliciousLeases();
    openPorts.clear();
    spawnMock.mockClear();
    spawnSyncMock.mockClear();
    fakeKill.mockClear();
  });

  it("uses the provided storageDir instead of mkdtemp", async () => {
    const storageDir = join(tmpdir(), `cn-tiny-pin-${Date.now()}`);
    const child = await ensureTinylicious(38471, { storageDir });
    expect(child?.pid).toBe(4242);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env.storage).toBe(resolve(storageDir));
    expect(env.PORT).toBe("38471");
    expect(env.storage).not.toMatch(/collabnode-tinylicious-/);
    releaseTinylicious(38471);
  });

  it("falls back to a temp snapshot dir when storageDir is omitted", async () => {
    await ensureTinylicious(38472);
    const env = spawnMock.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(env.storage).toMatch(/collabnode-tinylicious-38472-/);
    releaseTinylicious(38472);
  });

  it("does not spawn when the port is already open", async () => {
    openPorts.add(38473);
    const child = await ensureTinylicious(38473, { storageDir: "/tmp/ignored" });
    expect(child).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    releaseTinylicious(38473);
  });

  it("reuses a spawned child and does not stop it while another user remains", async () => {
    const dir = join(tmpdir(), "cn-share");
    const first = await ensureTinylicious(38474, { storageDir: dir });
    const second = await ensureTinylicious(38474, { storageDir: dir });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    releaseTinylicious(38474);
    expect(fakeKill).not.toHaveBeenCalled();
    releaseTinylicious(38474);
    expect(fakeKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not kill a pre-started Tinylicious on release", async () => {
    openPorts.add(38475);
    await ensureTinylicious(38475);
    releaseTinylicious(38475);
    expect(fakeKill).not.toHaveBeenCalled();
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("joins concurrent callers on one spawn and keeps the child until the last release", async () => {
    const storageDir = join(tmpdir(), "cn-concurrent");
    const [first, second] = await Promise.all([
      ensureTinylicious(38476, { storageDir }),
      ensureTinylicious(38476, { storageDir }),
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first?.pid).toBeTruthy();
    releaseTinylicious(38476);
    expect(fakeKill).not.toHaveBeenCalled();
    releaseTinylicious(38476);
    expect(fakeKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("respawns when the previous child has exited", async () => {
    const storageDir = join(tmpdir(), "cn-respawn");
    const first = await ensureTinylicious(38477, { storageDir });
    expect(first).toBeTruthy();
    first!.exitCode = 1;
    openPorts.delete(38477);
    const second = await ensureTinylicious(38477, { storageDir });
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second?.pid).not.toBe(first?.pid);
    releaseTinylicious(38477);
    expect(fakeKill).not.toHaveBeenCalled();
    releaseTinylicious(38477);
    expect(fakeKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("respawns when a pre-started server disappears", async () => {
    openPorts.add(38478);
    const first = await ensureTinylicious(38478);
    expect(first).toBeUndefined();
    expect(spawnMock).not.toHaveBeenCalled();
    openPorts.delete(38478);
    const second = await ensureTinylicious(38478, { storageDir: join(tmpdir(), "cn-prestart-gone") });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second?.pid).toBeTruthy();
    releaseTinylicious(38478);
    expect(fakeKill).not.toHaveBeenCalled();
    releaseTinylicious(38478);
    expect(fakeKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("warns when a later caller pins a different storageDir", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await ensureTinylicious(38479, { storageDir: join(tmpdir(), "cn-dir-a") });
    await ensureTinylicious(38479, { storageDir: join(tmpdir(), "cn-dir-b") });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/already using storageDir/));
    warn.mockRestore();
    releaseTinylicious(38479);
    releaseTinylicious(38479);
  });
});
