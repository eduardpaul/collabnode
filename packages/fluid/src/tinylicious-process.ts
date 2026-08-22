import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";

async function isPortOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ port, host }, () => {
      socket.end();
      resolveOpen(true);
    });
    socket.on("error", () => resolveOpen(false));
  });
}

export async function waitForPort(port: number, host = "127.0.0.1", timeoutMs = 15_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port, host)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

/** Env for a Tinylicious child. Isolated `storage` avoids corrupt git snapshots from a previous kill. */
export function tinyliciousSpawnEnv(
  port: number,
  storageDir: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    PORT: String(port),
    storage: storageDir,
    logger__level: env.TINYLICIOUS_LOG_LEVEL ?? "error",
  };
}

export interface EnsureTinyliciousOptions {
  /** Pin snapshots (e.g. `data/tinylicious`) so documentIds survive a process restart. */
  storageDir?: string;
}

type TinyliciousLease = {
  child: ChildProcess | undefined;
  refs: number;
  ready: Promise<ChildProcess | undefined>;
  /** False while the first caller (or a revive) is still probing/spawning. */
  started: boolean;
  /** Snapshot dir this process spawned with. Unset for a pre-started server. */
  storageDir?: string;
  settle: (child: ChildProcess | undefined) => void;
  fail: (err: unknown) => void;
};

const leases = new Map<number, TinyliciousLease>();

function resolveStorageDir(port: number, storageDir: string | undefined): string {
  if (storageDir) {
    const dir = resolve(storageDir);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  return mkdtempSync(join(tmpdir(), `collabnode-tinylicious-${port}-`));
}

function isChildDead(child: ChildProcess): boolean {
  return child.exitCode != null || child.signalCode != null || child.killed;
}

function adoptStorageDir(
  lease: TinyliciousLease,
  options: EnsureTinyliciousOptions | undefined,
  pending: boolean,
): void {
  if (!options?.storageDir) {
    return;
  }
  const requested = resolve(options.storageDir);
  if (!lease.storageDir) {
    if (pending) {
      lease.storageDir = requested;
    } else {
      console.warn(
        `ensureTinylicious: Tinylicious is already running; ignoring storageDir '${requested}'`,
      );
    }
    return;
  }
  if (lease.storageDir !== requested) {
    console.warn(
      `ensureTinylicious: already using storageDir '${lease.storageDir}'; ignoring '${requested}'`,
    );
  }
}

function newReady(): Pick<TinyliciousLease, "ready" | "settle" | "fail"> {
  let settle!: (child: ChildProcess | undefined) => void;
  let fail!: (err: unknown) => void;
  const ready = new Promise<ChildProcess | undefined>((resolveReady, rejectReady) => {
    settle = resolveReady;
    fail = rejectReady;
  });
  void ready.catch(() => undefined);
  return { ready, settle, fail };
}

function beginLease(port: number, options?: EnsureTinyliciousOptions): TinyliciousLease | undefined {
  if (leases.has(port)) {
    return undefined;
  }
  const lease: TinyliciousLease = {
    child: undefined,
    refs: 1,
    started: false,
    storageDir: options?.storageDir ? resolve(options.storageDir) : undefined,
    ...newReady(),
  };
  leases.set(port, lease);
  return lease;
}

async function spawnTinylicious(
  port: number,
  lease: TinyliciousLease,
  options: EnsureTinyliciousOptions | undefined,
  probeExisting: boolean,
): Promise<ChildProcess | undefined> {
  if (probeExisting && (await waitForPort(port, "127.0.0.1", 500))) {
    return undefined;
  }
  const storageDir = resolveStorageDir(port, lease.storageDir ?? options?.storageDir);
  lease.storageDir = storageDir;
  const verbose = Boolean(process.env.TINYLICIOUS_LOG_LEVEL);
  const child = spawn("npx", ["--yes", "tinylicious"], {
    stdio: verbose ? ["ignore", "pipe", "pipe"] : "ignore",
    env: tinyliciousSpawnEnv(port, storageDir),
  });
  if (verbose) {
    child.stdout?.on("data", forwardTinyliciousLog);
    child.stderr?.on("data", forwardTinyliciousLog);
  }
  const ready = await waitForPort(port);
  if (!ready) {
    stopTinylicious(child);
    throw new Error(
      `Could not start Tinylicious on port ${port}. Install tinylicious (\`npx tinylicious\`) or pass collab.port after starting it yourself.`,
    );
  }
  return child;
}

async function runStart(
  lease: TinyliciousLease,
  port: number,
  options: EnsureTinyliciousOptions | undefined,
  probeExisting: boolean,
): Promise<ChildProcess | undefined> {
  try {
    const child = await spawnTinylicious(port, lease, options, probeExisting);
    if (leases.get(port) !== lease) {
      return child;
    }
    lease.child = child;
    lease.started = true;
    lease.settle(child);
    return child;
  } catch (err) {
    if (leases.get(port) === lease) {
      leases.delete(port);
    }
    lease.fail(err);
    throw err;
  }
}

function beginRevive(lease: TinyliciousLease): boolean {
  if (!lease.started) {
    return false;
  }
  const next = newReady();
  lease.ready = next.ready;
  lease.settle = next.settle;
  lease.fail = next.fail;
  lease.started = false;
  lease.child = undefined;
  return true;
}

export async function ensureTinylicious(
  port: number,
  options?: EnsureTinyliciousOptions,
): Promise<ChildProcess | undefined> {
  for (;;) {
    const lease = leases.get(port);
    if (!lease) {
      const created = beginLease(port, options);
      if (!created) {
        continue;
      }
      return runStart(created, port, options, true);
    }

    if (!lease.started) {
      adoptStorageDir(lease, options, true);
      lease.refs += 1;
      return lease.ready;
    }

    const dead = lease.child ? isChildDead(lease.child) : !(await isPortOpen(port));
    if (leases.get(port) !== lease) {
      continue;
    }
    if (!dead) {
      adoptStorageDir(lease, options, false);
      lease.refs += 1;
      return lease.ready;
    }

    adoptStorageDir(lease, options, true);
    lease.refs += 1;
    if (!beginRevive(lease)) {
      return lease.ready;
    }
    return runStart(lease, port, options, false);
  }
}

/**
 * Drop one in-process user of Tinylicious on `port`.
 * Stops the child only if this process spawned it and no other users remain.
 * A pre-started server (lease.child is undefined) is left running.
 */
export function releaseTinylicious(port: number): void {
  const lease = leases.get(port);
  if (!lease || lease.refs <= 0) {
    return;
  }
  lease.refs -= 1;
  if (lease.refs > 0) {
    return;
  }
  leases.delete(port);
  stopTinylicious(lease.child);
}

/** Test helper: forget leases without killing a real pre-started server. */
export function resetTinyliciousLeases(): void {
  leases.clear();
}

const STALE_DOCUMENT = /Could not find heads\/|Error while fetching summary|Failed to get orderer manager|Connect Server Error|Connect document failed/;

/** Leftover browser tabs keep asking Tinylicious for a documentId from a previous `init()`. */
export function isStaleTinyliciousLog(text: string): boolean {
  return STALE_DOCUMENT.test(text);
}

function forwardTinyliciousLog(chunk: Buffer | string): void {
  const text = String(chunk);
  if (isStaleTinyliciousLog(text)) {
    return;
  }
  process.stderr.write(chunk);
}

/** Kill npx and the Tinylicious grandchild. `child.kill()` alone often leaves port 7070 occupied. */
export function stopTinylicious(child: ChildProcess | undefined): void {
  if (!child?.pid) {
    return;
  }
  for (const [port, lease] of leases) {
    if (lease.child === child) {
      leases.delete(port);
    }
  }
  const pid = child.pid;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  spawnSync("pkill", ["-TERM", "-P", String(pid)], { stdio: "ignore" });
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
}
