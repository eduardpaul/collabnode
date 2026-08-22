import { parseDuration } from "@collabnode/schema";
import type { Hub } from "./hub.js";
import type { EndReason, WorkspaceArtifact } from "./types.js";

export class Reaper {
  private readonly hub: Hub;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(hub: Hub, intervalMs = 10_000) {
    this.hub = hub;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.intervalMs <= 0 || this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Unref so the background timer does not hold the Node process open
    if (typeof this.timer.unref === "function") {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      await this.hub.sweep();
    } catch {
      // Background reaper exceptions are swallowed to preserve timer loop
    } finally {
      this.running = false;
    }
  }
}

export async function sweepWorkspaces(
  hub: Hub,
  now = Date.now(),
): Promise<WorkspaceArtifact[]> {
  const swept: WorkspaceArtifact[] = [];
  const dueRecords = await hub.registry.due(now);

  for (const record of dueRecords) {
    if (record.state !== "active") {
      continue;
    }

    const type = hub.getType(record.typeName);
    if (!type) {
      continue;
    }

    let endReason: EndReason | undefined;

    // Trigger 1: maxDuration
    if (type.lifecycle?.maxDuration) {
      const maxMs = parseDuration(type.lifecycle.maxDuration);
      const openedAtMs = Date.parse(record.openedAt);
      if (now - openedAtMs >= maxMs) {
        endReason = "duration";
      }
    }

    // Trigger 2: idleTimeout
    if (!endReason && type.lifecycle?.idleTimeout) {
      const idleMs = parseDuration(type.lifecycle.idleTimeout);
      const liveWs = hub.getLiveWorkspace(record.id);
      const activePeers = liveWs ? liveWs.peers().length : 0;

      if (activePeers === 0) {
        const lastWriteMs = Date.parse(liveWs ? liveWs.lastWriteAt : (record.lastWriteAt || record.openedAt));
        const lastActivityMs = Date.parse(liveWs ? liveWs.lastActivityAt : (record.lastActivityAt || record.openedAt));
        const lastActive = Math.max(lastWriteMs, lastActivityMs);
        if (now - lastActive >= idleMs) {
          endReason = "idle";
        }
      }

    }

    // Trigger 3: endWhen predicate
    if (!endReason && type.lifecycle?.endWhen) {
      const liveWs = hub.getLiveWorkspace(record.id);
      if (liveWs) {
        const predicateMatched = await liveWs.evaluateEndWhen();
        if (predicateMatched) {
          // evaluateEndWhen initiates termination
          continue;
        }
      }
    }

    if (endReason) {
      // Acquire lease before terminating to prevent multi-replica double reaping
      const lease = await hub.registry.claim(record.id, 10_000);
      if (!lease) {
        continue;
      }

      try {
        let ws = hub.getLiveWorkspace(record.id);
        if (!ws) {
          // Load workspace handle to perform clean termination sequence
          ws = await hub.open(record.typeName, {
            id: record.id,
            params: record.params,
          });
        }
        const artifact = await ws.end(endReason);
        swept.push(artifact);
      } catch {
        // Leave for next sweep or error handler
      } finally {
        await hub.registry.release(lease);
      }
    }
  }

  return swept;
}
