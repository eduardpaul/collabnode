import { sha256Hex } from "./hash.js";
import type { GraphSchema, IdStrategy } from "./types.js";
import { SchemaError } from "./types.js";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(time: number): string {
  let remaining = time;
  const chars: string[] = Array.from({ length: 10 });
  for (let i = 9; i >= 0; i -= 1) {
    chars[i] = CROCKFORD[remaining % 32];
    remaining = Math.floor(remaining / 32);
  }
  return chars.join("");
}

function encodeRandom(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += CROCKFORD[(value << (5 - bits)) & 31];
  }
  return output.slice(0, 16);
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * Last id's millisecond and random component, kept so ids made inside one
 * millisecond can continue from each other instead of starting over.
 */
let lastTime = -1;
let lastRandom = randomBytes(10);

/** Add one to the random component, carrying left. */
function incrementRandom(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    if ((bytes[i] as number) < 0xff) {
      bytes[i] = (bytes[i] as number) + 1;
      return;
    }
    bytes[i] = 0;
  }
  // 2^80 ids in one millisecond. Unreachable, and wrapping is the least
  // surprising thing to do if it ever were not.
}

/**
 * A ULID: 10 characters of millisecond timestamp, then 16 of randomness, in
 * Crockford base32 — an alphabet ordered so that sorting the strings sorts the
 * values.
 *
 * Monotonic within a millisecond, which is what makes these usable as a
 * tiebreak. `Date.now()` has millisecond resolution and two graph writes
 * routinely land in the same one; drawing fresh randomness each time would make
 * their relative order a coin flip, so `graph_history` would report "what
 * happened last" differently on each read. Incrementing the previous random
 * component instead keeps ids in creation order while leaving them unique.
 *
 * The sequence is per process. Two peers writing in the same millisecond still
 * order arbitrarily, which is fine: convergence needs every replica to agree on
 * an order, not to recover the true one.
 */
export function ulid(now = Date.now()): string {
  if (now === lastTime) {
    incrementRandom(lastRandom);
  } else {
    // Includes a clock that stepped backwards: ordering there is no worse than
    // it would be without any of this.
    lastTime = now;
    lastRandom = randomBytes(10);
  }
  return encodeTime(now) + encodeRandom(lastRandom);
}

export function generateId(strategy: IdStrategy): string {
  if (strategy === "literal") {
    throw new SchemaError("idStrategy 'literal' requires an explicit id on each mutation");
  }
  if (strategy === "ulid") {
    return ulid();
  }
  return crypto.randomUUID();
}

export function identityId(
  schema: GraphSchema,
  nodeType: string,
  properties: Record<string, unknown>,
): string | undefined {
  const def = schema.nodes[nodeType];
  if (!def?.identity) {
    return undefined;
  }
  const parts = def.identity.from.map((field) => {
    const value = properties[field];
    if (value === undefined || value === null || value === "") {
      throw new SchemaError(
        `identity field '${field}' is required to mint an id for node type '${nodeType}'`,
        `nodes.${nodeType}.identity`,
      );
    }
    return String(value);
  });
  const material = `${schema.config.schemaId}:${nodeType}:${parts.join("|")}`;
  return sha256Hex(material).slice(0, 32);
}

/**
 * The id of a singleton type's one node.
 *
 * Derived from the schema and the type name, so it is the same on every replica
 * and in every process: two peers creating the node at the same moment write to
 * one id and the CRDT merges them, rather than each minting a random id and the
 * document ending up with two nodes nothing can tell apart.
 *
 * The material carries a marker rather than property values, and a singleton
 * type cannot be identity-keyed, so this can never collide with `identityId`.
 */
export function singletonId(schema: GraphSchema, nodeType: string): string {
  return sha256Hex(`${schema.config.schemaId}:${nodeType}:\u0000singleton`).slice(0, 32);
}
