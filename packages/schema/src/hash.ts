import { sha256 } from "@noble/hashes/sha2.js";

export function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

export function sha256Hex(text: string): string {
  const bytes = sha256(new TextEncoder().encode(text));
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

export function sha256Canonical(value: unknown): string {
  return sha256Hex(JSON.stringify(canonicalJson(value)));
}
