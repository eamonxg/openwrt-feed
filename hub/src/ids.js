// Crockford-lowercase alphabet (no i/l/o/u) — 32 characters exactly, so a
// modulo-256 byte maps onto it with zero bias (256 / 32 = 8, no remainder).
const SHORT_ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const SHORT_ID_LENGTH = 8;

export function shortId() {
  const bytes = crypto.getRandomValues(new Uint8Array(SHORT_ID_LENGTH));
  let id = "";
  for (let i = 0; i < SHORT_ID_LENGTH; i++) {
    id += SHORT_ID_ALPHABET[bytes[i] % SHORT_ID_ALPHABET.length];
  }
  return id;
}

function compareCodePoint(a, b) {
  const ac = Array.from(a);
  const bc = Array.from(b);
  const len = Math.min(ac.length, bc.length);
  for (let i = 0; i < len; i++) {
    const diff = ac[i].codePointAt(0) - bc[i].codePointAt(0);
    if (diff !== 0) return diff;
  }
  return ac.length - bc.length;
}

function stringify(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      const part = stringify(item);
      return part === undefined ? "null" : part;
    });
    return "[" + parts.join(",") + "]";
  }
  const keys = Object.keys(value).sort(compareCodePoint);
  const parts = [];
  for (const key of keys) {
    const part = stringify(value[key]);
    if (part === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + part);
  }
  return "{" + parts.join(",") + "}";
}

export function canonicalJson(value) {
  return stringify(value);
}

export async function sha256Hex(bufferOrString) {
  const data =
    typeof bufferOrString === "string"
      ? new TextEncoder().encode(bufferOrString)
      : bufferOrString;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function contentHash(value) {
  return sha256Hex(canonicalJson(value));
}
