import { randomUUID } from "node:crypto";
import type { Lease, WorkspaceRecord, WorkspaceRegistry, WorkspaceState } from "./types.js";

export class MemoryWorkspaceRegistry implements WorkspaceRegistry {
  private readonly records = new Map<string, WorkspaceRecord>();
  private readonly leases = new Map<string, { token: string; expiresAt: number }>();

  async claim(id: string, ttlMs: number): Promise<Lease | undefined> {
    const now = Date.now();
    const existing = this.leases.get(id);
    if (existing && existing.expiresAt > now) {
      return undefined;
    }
    const token = randomUUID();
    const expiresAt = now + ttlMs;
    this.leases.set(id, { token, expiresAt });

    const record = this.records.get(id);
    if (record) {
      record.leaseToken = token;
      record.leaseExpiresAt = expiresAt;
    }
    return { id, token, expiresAt };
  }

  async heartbeat(lease: Lease, ttlMs: number): Promise<boolean> {
    const current = this.leases.get(lease.id);
    if (!current || current.token !== lease.token) {
      return false;
    }
    const expiresAt = Date.now() + ttlMs;
    current.expiresAt = expiresAt;
    lease.expiresAt = expiresAt;

    const record = this.records.get(lease.id);
    if (record && record.leaseToken === lease.token) {
      record.leaseExpiresAt = expiresAt;
    }
    return true;
  }

  async release(lease: Lease): Promise<void> {
    const current = this.leases.get(lease.id);
    if (current && current.token === lease.token) {
      this.leases.delete(lease.id);
      const record = this.records.get(lease.id);
      if (record && record.leaseToken === lease.token) {
        delete record.leaseToken;
        delete record.leaseExpiresAt;
      }
    }
  }

  async due(now: number, limit = 50): Promise<WorkspaceRecord[]> {
    const results: WorkspaceRecord[] = [];
    for (const record of this.records.values()) {
      if (record.state === "active") {
        results.push({ ...record });
        if (results.length >= limit) {
          break;
        }
      }
    }
    return results;
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async put(record: WorkspaceRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
    this.leases.delete(id);
  }

  async list(filter?: { state?: WorkspaceState; typeName?: string }): Promise<WorkspaceRecord[]> {
    const results: WorkspaceRecord[] = [];
    for (const record of this.records.values()) {
      if (filter?.state && record.state !== filter.state) {
        continue;
      }
      if (filter?.typeName && record.typeName !== filter.typeName) {
        continue;
      }
      results.push({ ...record });
    }
    return results;
  }
}

export function memoryRegistry(): WorkspaceRegistry {
  return new MemoryWorkspaceRegistry();
}
