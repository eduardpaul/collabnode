import type { RedisLike } from "@collabnode/redis";
import type { BoardNameStore } from "./boards.ts";

/**
 * Board names in Redis, next to the registry records they belong to.
 *
 * One key per board rather than one hash for all of them: Azure Managed Redis
 * can be clustered, and a per-board key is a single-key command whatever slot
 * it lands in.
 */
export function redisBoardNames(client: RedisLike, prefix: string): BoardNameStore {
  const key = (id: string): string => `${prefix}:board-name:${id}`;
  return {
    async get(id) {
      return (await client.get(key(id))) ?? undefined;
    },
    async set(id, name) {
      await client.set(key(id), name);
    },
    async delete(id) {
      await client.del(key(id));
    },
  };
}
