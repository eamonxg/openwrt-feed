import { describe, expect, it } from "vitest";
import { shortId, canonicalJson, contentHash, sha256Hex } from "../../src/ids.js";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

describe("shortId", () => {
  it("returns an 8 character string", () => {
    const id = shortId();
    expect(id).toHaveLength(8);
  });

  it("only uses characters from the Crockford-lowercase alphabet", () => {
    const id = shortId();
    for (const ch of id) {
      expect(ALPHABET).toContain(ch);
    }
  });

  it("produces no collisions across 1000 calls", () => {
    const seen = new Set();
    for (let i = 0; i < 1000; i++) {
      seen.add(shortId());
    }
    expect(seen.size).toBe(1000);
  });
});

describe("canonicalJson", () => {
  it("produces the same string regardless of key insertion order", () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("sorts keys by unicode code point ascending", () => {
    const value = { b: 1, a: 2, ab: 3 };
    expect(canonicalJson(value)).toBe('{"a":2,"ab":3,"b":1}');
  });

  it("recursively sorts nested object keys", () => {
    const value = { z: { d: 1, c: 2 }, a: 1 };
    expect(canonicalJson(value)).toBe('{"a":1,"z":{"c":2,"d":1}}');
  });

  it("preserves array element order", () => {
    const value = { b: [3, 2, 1], a: 1 };
    expect(canonicalJson(value)).toBe('{"a":1,"b":[3,2,1]}');
  });

  it("sorts keys inside objects nested in arrays", () => {
    const value = [{ b: 1, a: 2 }];
    expect(canonicalJson(value)).toBe('[{"a":2,"b":1}]');
  });
});

describe("contentHash", () => {
  it("matches a known sha256 vector for {a:1,b:[2,3]}", async () => {
    const value = { b: [2, 3], a: 1 };
    // canonical form is {"a":1,"b":[2,3]}; computed with:
    // printf '%s' '{"a":1,"b":[2,3]}' | shasum -a 256
    const expected = "efbd0040190fb0871831e606c581f8a66db79d8e2bb836745a70051306956070";
    await expect(contentHash(value)).resolves.toBe(expected);
  });
});

describe("sha256Hex", () => {
  it("hashes a string to a 64 character lowercase hex digest", async () => {
    const hash = await sha256Hex("hello");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces the same digest for equivalent string and buffer input", async () => {
    const str = await sha256Hex("hello");
    const buf = await sha256Hex(new TextEncoder().encode("hello"));
    expect(buf).toBe(str);
  });
});
