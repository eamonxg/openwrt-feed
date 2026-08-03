// Whitelist SVG sanitizer — the security-critical core of the moderation
// flow (Task 10). Pure function, zero dependencies, no DOMParser: workerd
// has no DOMParser, and the exact same implementation must run both in the
// Worker (a possible future server-side use) and inlined into admin.html's
// browser context. A hand-written XML tokenizer/parser is used instead of
// any regex-only stripping — regex-based XML "sanitizers" are the classic
// bypass (they cannot track nesting, quoting, comments or CDATA correctly).
//
// Design: parse -> whitelist-filter tree -> re-serialize. Three stages:
//   1. parseXml(text)   hand-written recursive-descent tokenizer/parser.
//      Throws on any malformed XML (unbalanced tags, unclosed quotes,
//      unknown entities, more/less than one root element, ...).
//   2. sanitizeElement(node)  recursively applies the whitelist: elements
//      not in ALLOWED_ELEMENTS are dropped together with their whole
//      subtree (their content is never even considered for output); on
//      elements that survive, attributes go through the same one-veto
//      rules described in the task brief (on* handlers, href/xlink:href
//      that isn't a local "#fragment", any "url(...)" reference that isn't
//      "url(#...)").
//   3. serialize(node)  re-emits the surviving tree as XML text, escaping
//      all text/attribute content so nothing that survives stage 2 can ever
//      re-become live markup (this is what makes CDATA- or entity-hidden
//      "<script>" text permanently inert: it comes back out as
//      "&lt;script&gt;", never as a tag).
//
// SYNC NOTE: site/admin/index.html inlines a byte-identical copy of this function
// body (admin.html has no build step, so it can't `import` this module) —
// keep the two in lockstep; each carries a comment pointing at the other.

// ---------------------------------------------------------------------------
// Whitelists (task brief, verbatim)
// ---------------------------------------------------------------------------

const ALLOWED_ELEMENTS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline",
  "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath",
  "mask", "pattern", "symbol", "use", "text", "tspan", "title", "desc",
  "style",
]);

// Explicit non-presentation attributes named in the brief.
const ALLOWED_ATTRS = new Set([
  "id", "class", "viewBox", "width", "height", "x", "y", "x1", "y1", "x2",
  "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform", "offset",
  "stop-color", "stop-opacity", "fill", "stroke", "stroke-width", "opacity",
  "clip-path", "mask", "href", "xlink:href", "gradientUnits",
  "gradientTransform", "patternUnits", "preserveAspectRatio", "font-family",
  "font-size", "font-weight", "font-style", "text-anchor",
  // "style" is itself a presentation attribute (inline CSS) — the brief's
  // one-veto rule explicitly calls out checking "style element/attribute"
  // text for non-local url(...), which only makes sense if the attribute is
  // allowed at all.
  "style",
]);

// Additional common SVG presentation attributes ("表现属性" is named as a
// whole category in the brief, not just the handful spelled out above) —
// none of these carry any script/network capability on their own.
const PRESENTATION_EXTRA = new Set([
  "fill-opacity", "fill-rule", "stroke-opacity", "stroke-linecap",
  "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray",
  "stroke-dashoffset", "clip-rule", "color", "display", "visibility",
  "cursor", "pointer-events", "font-variant", "font-stretch",
  "letter-spacing", "word-spacing", "text-decoration", "overflow",
  "marker-start", "marker-mid", "marker-end", "direction", "unicode-bidi",
  "vector-effect", "shape-rendering", "image-rendering", "paint-order",
]);

function isAttrAllowed(name) {
  return (
    ALLOWED_ATTRS.has(name) ||
    PRESENTATION_EXTRA.has(name) ||
    name.startsWith("stroke-") ||
    name.startsWith("font-")
  );
}

const HREF_ATTRS = new Set(["href", "xlink:href"]);

// ---------------------------------------------------------------------------
// Tiny XML tokenizer/parser
// ---------------------------------------------------------------------------
//
// Produces a tree of:
//   { type: "element", name, attrs: [[name, decodedValue], ...], children }
//   { type: "text", value: decodedString }
// Comments, the XML declaration/other processing instructions, and DOCTYPEs
// are recognized and discarded entirely — DOCTYPE internal subsets (where a
// classic XXE/custom-entity trick would be declared) are skipped over
// unexecuted, never interpreted.

class XmlSyntaxError extends Error {}

function isWhitespace(ch) {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

// A conservative XML Name production (ASCII only — every whitelisted
// element/attribute name is plain ASCII, so nothing legitimate is lost):
// letters/underscore to start, then letters/digits/'.'/'_'/':'/'-' (the
// colon is needed for "xlink:href", the hyphen for "stop-color" etc.).
// Fix-round 1 (security review): `readNameLike` used to stop only at
// whitespace or a caller-supplied stop-char set (e.g. "=/>"), which let a
// name smuggle in a literal '"' — e.g. an attribute typed as
// `font-family"x="1"` reads as the single (bogus) name `font-family"x`,
// which then passed `isAttrAllowed`'s `startsWith("font-")` wildcard and,
// since `serialize()` never escapes attribute *names* (only values), came
// back out with the quote unescaped — breaking the attribute's quoting in
// whatever re-parses the sanitized output. Every name (element and
// attribute) is now validated against this pattern immediately after being
// read; anything else is treated as malformed XML rather than silently
// patched around, consistent with the rest of the parser's fail-fast
// stance on syntax errors.
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._:-]*$/;

function assertValidName(name, context) {
  if (!NAME_PATTERN.test(name)) {
    throw new XmlSyntaxError(`Invalid ${context} name: ${JSON.stringify(name)}`);
  }
}

function decodeEntities(raw) {
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== "&") {
      out += ch;
      i += 1;
      continue;
    }

    const semi = raw.indexOf(";", i + 1);
    if (semi === -1 || semi - i > 12) {
      throw new XmlSyntaxError("Unterminated entity reference.");
    }
    const body = raw.slice(i + 1, semi);

    if (body === "lt") out += "<";
    else if (body === "gt") out += ">";
    else if (body === "amp") out += "&";
    else if (body === "quot") out += '"';
    else if (body === "apos") out += "'";
    else if (/^#[0-9]+$/.test(body)) {
      out += codePointToChar(Number.parseInt(body.slice(1), 10));
    } else if (/^#x[0-9a-fA-F]+$/.test(body)) {
      out += codePointToChar(Number.parseInt(body.slice(2), 16));
    } else {
      // Any other named entity is undefined without a DTD we actually
      // process (we deliberately never execute a DOCTYPE's internal
      // subset) — per strict XML this is a well-formedness error, and
      // rejecting it also closes off the classic XXE/custom-entity
      // obfuscation trick outright, rather than trying to guess intent.
      throw new XmlSyntaxError(`Unknown entity reference: &${body};`);
    }

    i = semi + 1;
  }
  return out;
}

function codePointToChar(codePoint) {
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    throw new XmlSyntaxError("Invalid numeric character reference.");
  }
}

function parseXml(text) {
  // Strip a leading UTF-8 BOM if the string still carries one.
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const len = src.length;
  let i = 0;

  const root = { type: "root", children: [] };
  const stack = [root];

  function currentChildren() {
    return stack[stack.length - 1].children;
  }

  function readNameLike(stopChars) {
    const start = i;
    while (i < len && !isWhitespace(src[i]) && !stopChars.includes(src[i])) {
      i += 1;
    }
    if (i === start) {
      throw new XmlSyntaxError("Expected a name.");
    }
    return src.slice(start, i);
  }

  function skipWhitespace() {
    while (i < len && isWhitespace(src[i])) i += 1;
  }

  function parseAttributes() {
    const attrs = [];
    for (;;) {
      skipWhitespace();
      if (i >= len) throw new XmlSyntaxError("Unclosed start tag.");
      if (src[i] === ">" || src[i] === "/") break;

      const name = readNameLike("=/>");
      assertValidName(name, "attribute");
      skipWhitespace();
      if (src[i] !== "=") {
        // e.g. a bare boolean-style attribute, or whitespace splitting what
        // looked like one attribute name into two tokens ("on load=..."):
        // XML requires name="value" for every attribute, no exceptions.
        throw new XmlSyntaxError(`Attribute "${name}" is missing "=value".`);
      }
      i += 1; // consume '='
      skipWhitespace();
      const quote = src[i];
      if (quote !== '"' && quote !== "'") {
        throw new XmlSyntaxError(`Attribute "${name}" value must be quoted.`);
      }
      i += 1;
      const valStart = i;
      const closeQuote = src.indexOf(quote, i);
      if (closeQuote === -1) {
        throw new XmlSyntaxError(`Unclosed quote for attribute "${name}".`);
      }
      const rawValue = src.slice(valStart, closeQuote);
      i = closeQuote + 1;
      attrs.push([name, decodeEntities(rawValue)]);
    }
    return attrs;
  }

  while (i < len) {
    if (src[i] !== "<") {
      const start = i;
      const next = src.indexOf("<", i);
      const end = next === -1 ? len : next;
      const rawText = src.slice(start, end);
      i = end;
      currentChildren().push({ type: "text", value: decodeEntities(rawText) });
      continue;
    }

    if (src.startsWith("<!--", i)) {
      const close = src.indexOf("-->", i + 4);
      if (close === -1) throw new XmlSyntaxError("Unclosed comment.");
      i = close + 3;
      continue; // comments are discarded, not added to the tree
    }

    if (src.startsWith("<![CDATA[", i)) {
      const close = src.indexOf("]]>", i + 9);
      if (close === -1) throw new XmlSyntaxError("Unclosed CDATA section.");
      // CDATA content is literal text per XML: no entity decoding, and
      // critically no tag parsing — a "<script>" string in here is data,
      // never markup (serialize() re-escapes it on the way back out).
      const raw = src.slice(i + 9, close);
      i = close + 3;
      currentChildren().push({ type: "text", value: raw });
      continue;
    }

    if (src.startsWith("<!DOCTYPE", i) || src.startsWith("<!doctype", i)) {
      // Skip to the matching top-level '>', tracking '[' ... ']' nesting so
      // an internal subset's own declarations (each terminated by their own
      // '>') can't be mistaken for the doctype's close. The subset's
      // content (e.g. a custom <!ENTITY ...> declaration) is never
      // examined or executed — it is discarded along with everything else
      // here.
      let depth = 0;
      let j = i + 9;
      let closed = false;
      for (; j < len; j += 1) {
        if (src[j] === "[") depth += 1;
        else if (src[j] === "]") depth -= 1;
        else if (src[j] === ">" && depth <= 0) {
          closed = true;
          break;
        }
      }
      if (!closed) throw new XmlSyntaxError("Unclosed DOCTYPE declaration.");
      i = j + 1;
      continue; // DOCTYPE is discarded wholesale
    }

    if (src.startsWith("<?", i)) {
      const close = src.indexOf("?>", i + 2);
      if (close === -1) throw new XmlSyntaxError("Unclosed processing instruction.");
      i = close + 2;
      continue;
    }

    if (src.startsWith("</", i)) {
      i += 2;
      const name = readNameLike("/>");
      assertValidName(name, "element");
      skipWhitespace();
      if (src[i] !== ">") throw new XmlSyntaxError(`Malformed closing tag for "${name}".`);
      i += 1;
      const top = stack[stack.length - 1];
      if (stack.length <= 1 || top.name !== name) {
        throw new XmlSyntaxError(`Mismatched closing tag: expected "${top.name}", got "${name}".`);
      }
      stack.pop();
      continue;
    }

    // Opening (possibly self-closing) tag.
    i += 1;
    const name = readNameLike("/>");
    assertValidName(name, "element");
    const attrs = parseAttributes();
    if (i >= len) throw new XmlSyntaxError(`Unclosed start tag "${name}".`);

    let selfClosing = false;
    if (src[i] === "/") {
      selfClosing = true;
      i += 1;
      skipWhitespace();
    }
    if (src[i] !== ">") throw new XmlSyntaxError(`Malformed start tag "${name}".`);
    i += 1;

    const node = { type: "element", name, attrs, children: [] };
    currentChildren().push(node);
    if (!selfClosing) {
      stack.push(node);
    }
  }

  if (stack.length !== 1) {
    throw new XmlSyntaxError(`Unclosed element "${stack[stack.length - 1].name}".`);
  }

  const topLevelElements = root.children.filter(
    (node) => node.type === "element" || (node.type === "text" && node.value.trim() !== "")
  );
  if (topLevelElements.length !== 1 || topLevelElements[0].type !== "element") {
    throw new XmlSyntaxError("Document must have exactly one root element.");
  }

  return topLevelElements[0];
}

// ---------------------------------------------------------------------------
// url(...) one-veto check — shared by <style> element content and any
// attribute value (fill="url(...)", style="...", mask="url(...)", ...):
// only a same-document local fragment reference "url(#...)" is trusted;
// anything else is a network fetch the sanitizer must not let through.
// ---------------------------------------------------------------------------

// Fix-round 1 (security review): this used to build `lower =
// text.toLowerCase()` and then reuse indices found in `lower` to index back
// into the *original* `text`. Some Unicode characters change length under
// toLowerCase() (e.g. U+0130 "İ" -> "i" + a combining dot above, 1 code
// unit becomes 2), which desynchronizes every index after the first such
// character — padding a string with enough of them shifts a later
// "url(...)"'s computed position into the middle of an actual external
// URL, landing on a byte that happens to be '#' and wrongly passing as a
// local reference. Fixed by never lowercasing the whole string at all:
// match the literal 3-letter ASCII token "url(" case-insensitively one
// character at a time, directly against `text`'s own indices, so no index
// ever comes from a differently-sized copy of the string.
function isAsciiCi(ch, lower, upper) {
  return ch === lower || ch === upper;
}

function hasDisallowedUrl(text) {
  for (let i = 0; i + 4 <= text.length; i += 1) {
    if (
      !isAsciiCi(text[i], "u", "U") ||
      !isAsciiCi(text[i + 1], "r", "R") ||
      !isAsciiCi(text[i + 2], "l", "L") ||
      text[i + 3] !== "("
    ) {
      continue;
    }
    let pos = i + 4;
    while (pos < text.length && isWhitespace(text[pos])) pos += 1;
    if (text[pos] === '"' || text[pos] === "'") pos += 1;
    if (text[pos] !== "#") return true;
  }
  return false;
}

// <style> text can also reach the network via `@import url(...)` (or even
// the bare `@import "https://...";` form, no url() wrapper at all) — a
// non-local url(...) is already caught by hasDisallowedUrl above, but the
// quoted form isn't, since it never contains the literal token "url(". This
// is defense-in-depth (the asset is served with CSP default-src 'none' and
// only ever rendered as an <img>, per contract #8), so a plain case-
// insensitive substring match on the fixed ASCII token "@import" is enough —
// deliberately not attempting the CSS-escaped form (`\40 import`, `\75rl(`
// etc.), which is real CSS but not a realistic bypass here. Matched the same
// character-by-character way as hasDisallowedUrl (never via a whole-string
// .toLowerCase(), which the fix-round note above explains can desynchronize
// indices for certain Unicode input) so there is no analogous risk here.
function hasDisallowedAtImport(text) {
  const token = "@import";
  for (let i = 0; i + token.length <= text.length; i += 1) {
    let match = true;
    for (let j = 0; j < token.length; j += 1) {
      const ch = text[i + j];
      const want = token[j];
      if (want === "@") {
        if (ch !== "@") {
          match = false;
          break;
        }
      } else if (!isAsciiCi(ch, want, want.toUpperCase())) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Whitelist filtering
// ---------------------------------------------------------------------------

function sanitizeElement(node) {
  if (!ALLOWED_ELEMENTS.has(node.name)) {
    return null; // whole subtree removed, per the brief
  }

  const attrs = [];
  for (const [rawName, value] of node.attrs) {
    if (/^on/i.test(rawName)) continue; // one-veto: any event handler
    if (!isAttrAllowed(rawName)) continue; // not on the whitelist at all

    if (HREF_ATTRS.has(rawName) && !value.trim().startsWith("#")) {
      continue; // one-veto: only local "#fragment" refs survive
    }
    if (hasDisallowedUrl(value)) {
      continue; // one-veto: non-local url(...) anywhere in an attribute value
    }

    attrs.push([rawName, value]);
  }

  const children = [];
  for (const child of node.children) {
    if (child.type === "text") {
      children.push(child);
      continue;
    }
    const sanitizedChild = sanitizeElement(child);
    if (sanitizedChild) children.push(sanitizedChild);
  }

  if (node.name === "style") {
    const combinedText = children
      .filter((c) => c.type === "text")
      .map((c) => c.value)
      .join("");
    if (hasDisallowedUrl(combinedText) || hasDisallowedAtImport(combinedText)) {
      children.length = 0; // empty the style content, per the brief
    }
  }

  return { type: "element", name: node.name, attrs, children };
}

// ---------------------------------------------------------------------------
// Serialization — every text/attribute value is re-escaped here, which is
// what makes anything that survived stage 2 (e.g. CDATA- or
// entity-obfuscated "<script>" text) permanently inert on the way back out.
// ---------------------------------------------------------------------------

function escapeText(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serialize(node) {
  if (node.type === "text") return escapeText(node.value);

  // Defense in depth: names are already validated at parse time
  // (assertValidName), so this should be unreachable in normal operation —
  // but attribute *names* are never escaped below (only values are), so if
  // an invalid name ever reached this far, emitting it verbatim could break
  // the output's quoting. Fail loud instead.
  assertValidName(node.name, "element");
  for (const [name] of node.attrs) {
    assertValidName(name, "attribute");
  }

  const attrString = node.attrs.map(([name, value]) => ` ${name}="${escapeAttr(value)}"`).join("");
  if (node.children.length === 0) {
    return `<${node.name}${attrString}/>`;
  }
  const inner = node.children.map(serialize).join("");
  return `<${node.name}${attrString}>${inner}</${node.name}>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Sanitizes an SVG document against the task brief's whitelist. Throws a
// plain Error on any malformed XML (unbalanced tags, unclosed quotes,
// unknown entities, wrong number of root elements, ...) or if nothing
// whitelisted survives at all. Returns the re-serialized, sanitized SVG
// text otherwise. Pure function: same input always produces the same
// output, no globals, no I/O.
export function sanitizeSvg(svgText) {
  if (typeof svgText !== "string") {
    throw new Error("sanitizeSvg: input must be a string.");
  }

  let root;
  try {
    root = parseXml(svgText);
  } catch (err) {
    if (err instanceof XmlSyntaxError) {
      throw new Error(`sanitizeSvg: malformed XML — ${err.message}`);
    }
    throw err;
  }

  const sanitizedRoot = sanitizeElement(root);
  if (!sanitizedRoot) {
    throw new Error("sanitizeSvg: no whitelisted root element survived sanitization.");
  }

  try {
    return serialize(sanitizedRoot);
  } catch (err) {
    if (err instanceof XmlSyntaxError) {
      // Only assertValidName's defense-in-depth check inside serialize()
      // can throw this — unreachable in normal operation since names are
      // already validated at parse time, but wrapped the same way for a
      // consistent error surface if it ever does.
      throw new Error(`sanitizeSvg: malformed XML — ${err.message}`);
    }
    throw err;
  }
}
