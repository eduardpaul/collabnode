import { describe, expect, it } from "vitest";
import { generateId, ulid } from "../src/identity.ts";

describe("ulid", () => {
  it("is 26 characters of Crockford base32", () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts in creation order inside one millisecond", () => {
    // The reason this matters: `at` is an ISO string with millisecond
    // resolution, so history ties constantly and falls through to the opId.
    // Fresh randomness per id would make that order a coin flip.
    const ids = Array.from({ length: 200 }, () => ulid(1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("sorts by time across milliseconds", () => {
    const earlier = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_001);
    expect(earlier < later).toBe(true);
  });

  it("carries into the next byte rather than repeating an id", () => {
    // Force the low byte to the top of its range and keep going: the increment
    // has to carry left, or ids start colliding.
    const ids = new Set(Array.from({ length: 300 }, () => ulid(1_700_000_000_002)));
    expect(ids.size).toBe(300);
  });

  it("starts a fresh sequence when the clock steps backwards", () => {
    ulid(1_700_000_000_010);
    const back = ulid(1_700_000_000_005);
    expect(back.slice(0, 10)).toBe(ulid(1_700_000_000_005).slice(0, 10));
    expect(back < ulid(1_700_000_000_010)).toBe(true);
  });

  it("still keys the ulid id strategy", () => {
    expect(generateId("ulid")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});
