import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../../src/sanitize-svg.js";
// ?raw hands back the file's bytes as a string. node:fs is unavailable inside
// the workers pool, so this is how a test in here reads a file at all.
import serverSanitizerSource from "../../src/sanitize-svg.js?raw";
import browserSanitizerSource from "../../site/admin/sanitize-svg.js?raw";

// ---------------------------------------------------------------------------
// The two copies of the sanitizer must not drift.
//
// SVGs are sanitized TWICE by design: the console (site/admin/sanitize-svg.js)
// strips the bytes in the operator's browser and uploads the result, and the
// Worker (src/sanitize-svg.js) is the authority that everything else is
// written against. approve stores exactly the bytes the console sent, and it
// stores them believing they were sanitized by the server's rules.
//
// So a hole patched in src/ alone is silently not patched: the console keeps
// stripping by the old rules, and the bytes that reach R2 — and from there
// every router that downloads the config — carry whatever the new rule was
// added to catch, under a status that says "approved". Every vector below is
// only ever exercised against the src/ copy; this assertion is the entire
// reason those results say anything about the browser copy too.
//
// scripts/sync-sanitize-svg.mjs copies src/ -> site/admin/ (and --check
// verifies it), but a script only runs when someone remembers to run it.
// This test runs on every `vitest run`.
// ---------------------------------------------------------------------------

describe("site/admin/sanitize-svg.js is a byte-identical copy of src/sanitize-svg.js", () => {
  it("matches byte for byte", () => {
    // Not toBe(): a diff of two multi-KB sources is unreadable. Report the
    // fix instead — the actual bytes are one command away.
    if (browserSanitizerSource !== serverSanitizerSource) {
      expect.fail(
        "site/admin/sanitize-svg.js has drifted from src/sanitize-svg.js. " +
          "The admin console would sanitize by the old rules while approve stores those bytes as if " +
          "the server's rules had been applied. Run `node scripts/sync-sanitize-svg.mjs` to resync."
      );
    }
  });

  it("read a real, non-empty sanitizer from both paths", () => {
    // Guards the guard: if either import ever resolved to something empty,
    // the equality above would pass while checking nothing.
    expect(serverSanitizerSource).toContain("export function sanitizeSvg");
    expect(serverSanitizerSource.length).toBeGreaterThan(1000);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectThrows(input) {
  expect(() => sanitizeSvg(input)).toThrow();
}

// ---------------------------------------------------------------------------
// Brief's core vector list
// ---------------------------------------------------------------------------

describe("sanitizeSvg — element whitelist", () => {
  it("removes a <script> element entirely", () => {
    const out = sanitizeSvg('<svg><script>alert(1)</script><rect width="1" height="1"/></svg>');
    expect(out).not.toContain("script");
    expect(out).not.toContain("alert");
    expect(out).toContain("<rect");
  });

  it("removes <image href='http://...'> as a whole element (not on the whitelist)", () => {
    const out = sanitizeSvg('<svg><image href="http://evil.example/x.png"/><rect width="1"/></svg>');
    expect(out).not.toContain("<image");
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<rect");
  });

  it("drops foreignObject/iframe/embed/object/animate/set subtrees", () => {
    const out = sanitizeSvg(
      "<svg>" +
        '<foreignObject><body onload="x()">y</body></foreignObject>' +
        "<iframe src=\"http://evil\"></iframe>" +
        '<embed src="http://evil"/>' +
        '<object data="http://evil"></object>' +
        '<animate attributeName="x" to="1"/>' +
        '<set attributeName="x" to="1"/>' +
        '<g><rect width="1"/></g>' +
        "</svg>"
    );
    for (const bad of ["foreignObject", "iframe", "embed", "object", "animate", "<set", "evil"]) {
      expect(out).not.toContain(bad);
    }
    expect(out).toContain("<rect");
  });

  it("removes a nested <svg><g><script> but keeps the g/svg structure intact", () => {
    const out = sanitizeSvg('<svg><g><script>alert(1)</script><path d="M0 0"/></g></svg>');
    expect(out).not.toContain("script");
    // The root carries its xmlns declaration now (see "namespace
    // declarations" below), so match around it rather than pinning the
    // whole document byte for byte.
    expect(out).toMatch(/^<svg\b[^>]*><g><path d="M0 0"\/><\/g><\/svg>$/);
  });

  it("removes an unknown element with uppercase tag name (case-sensitive whitelist)", () => {
    const out = sanitizeSvg('<svg><SCRIPT>alert(1)</SCRIPT><rect width="1"/></svg>');
    expect(out).not.toContain("alert");
    expect(out).not.toMatch(/SCRIPT/);
    expect(out).toContain("<rect");
  });
});

describe("sanitizeSvg — attribute whitelist", () => {
  it("strips onload/onclick handlers but keeps the element", () => {
    const out = sanitizeSvg('<svg><rect onload="alert(1)" onclick="alert(2)" width="1" height="1"/></svg>');
    expect(out).not.toContain("onload");
    expect(out).not.toContain("onclick");
    expect(out).not.toContain("alert");
    expect(out).toContain("<rect");
    expect(out).toContain('width="1"');
  });

  it("strips on* handlers case-insensitively", () => {
    const out = sanitizeSvg('<svg><rect OnLoad="alert(1)" width="1"/></svg>');
    expect(out.toLowerCase()).not.toContain("onload");
    expect(out).not.toContain("alert");
  });

  it("drops href with a javascript: scheme", () => {
    const out = sanitizeSvg('<svg><use href="javascript:alert(1)"/></svg>');
    expect(out).not.toContain("javascript:");
  });

  it("drops namespaced xlink:href with a javascript: scheme", () => {
    const out = sanitizeSvg('<svg><use xlink:href="javascript:alert(1)"/></svg>');
    expect(out).not.toContain("javascript:");
  });

  it("keeps a local fragment href/xlink:href", () => {
    const out = sanitizeSvg('<svg><defs><path id="p1" d="M0 0"/></defs><use href="#p1"/></svg>');
    expect(out).toContain('href="#p1"');
  });

  it("drops an attribute not in the whitelist", () => {
    const out = sanitizeSvg('<svg><rect data-evil="1" width="1"/></svg>');
    expect(out).not.toContain("data-evil");
    expect(out).toContain('width="1"');
  });
});

describe("sanitizeSvg — url() one-veto", () => {
  it("keeps url(#grad) references", () => {
    const out = sanitizeSvg(
      '<svg><defs><linearGradient id="grad"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
        '<rect fill="url(#grad)" width="1"/></svg>'
    );
    expect(out).toContain("url(#grad)");
  });

  it("drops a fill attribute referencing an external url(...)", () => {
    const out = sanitizeSvg('<svg><rect fill="url(http://evil.example/x.svg#y)" width="1"/></svg>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("fill=");
  });

  it("empties a <style> element whose text contains a non-local url(...)", () => {
    const out = sanitizeSvg("<svg><style>rect{fill:url(http://evil.example/x.png)}</style><rect width=\"1\"/></svg>");
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("fill:url");
    expect(out).toMatch(/<style\s*\/>|<style><\/style>/);
  });

  it("keeps <style> text whose only url(...) is a local fragment", () => {
    const out = sanitizeSvg('<svg><style>rect{fill:url(#grad)}</style><rect width="1"/></svg>');
    expect(out).toContain("url(#grad)");
  });

  it("drops a style=\"\" attribute referencing a non-local url(...)", () => {
    const out = sanitizeSvg('<svg><rect style="fill:url(http://evil.example/x.png)" width="1"/></svg>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("style=");
  });
});

describe("sanitizeSvg — malformed XML is rejected", () => {
  it("rejects unbalanced/mismatched tags", () => {
    expectThrows('<svg><rect width="1"></svg>');
  });

  it("rejects an unclosed quote in an attribute value", () => {
    expectThrows('<svg><rect fill="red width="1"/></svg>');
  });

  it("rejects a document with more than one root element", () => {
    expectThrows("<svg></svg><svg></svg>");
  });

  it("rejects a document with no root element", () => {
    expectThrows("   ");
  });

  it("rejects an unclosed root element", () => {
    expectThrows('<svg><rect width="1"/>');
  });

  it("rejects an attribute written without '=value' (whitespace inside an attr name, e.g. 'on load')", () => {
    expectThrows('<svg><rect on load="1" width="1"/></svg>');
  });
});

describe("sanitizeSvg — round-trips legitimate content", () => {
  it("preserves a gradient + path SVG's structure and content", () => {
    const input =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
      '<defs><linearGradient id="g1" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#fff" stop-opacity="1"/>' +
      '<stop offset="1" stop-color="#000"/>' +
      "</linearGradient></defs>" +
      '<path d="M2 2 L20 20 Z" fill="url(#g1)" stroke="#123456" stroke-width="2"/>' +
      "</svg>";
    const out = sanitizeSvg(input);
    expect(out).toContain('viewBox="0 0 24 24"');
    expect(out).toContain('id="g1"');
    expect(out).toContain('x1="0"');
    expect(out).toContain('stop-color="#fff"');
    expect(out).toContain('d="M2 2 L20 20 Z"');
    expect(out).toContain('fill="url(#g1)"');
    expect(out).toContain('stroke-width="2"');
  });

  it("preserves text content (properly-escaped ampersand round-trips)", () => {
    const out = sanitizeSvg('<svg><text x="0" y="0">Hello &amp; welcome</text></svg>');
    expect(out).toContain("Hello &amp; welcome");
  });
});

// ---------------------------------------------------------------------------
// Namespace declarations
//
// Safe is not the whole job: the bytes are served as image/svg+xml and drawn
// in an <img>, so they are parsed as XML, and an <svg> root without
// xmlns="http://www.w3.org/2000/svg" is not an SVG at all -- it parses
// cleanly and renders nothing. A real upload (a 621-byte outline icon) was
// approved, stored at 582 bytes, and came back a broken-image glyph on the
// detail page for exactly this reason: the whitelist had no entry for xmlns,
// so the one attribute that makes the document an image was stripped.
// ---------------------------------------------------------------------------

describe("sanitizeSvg — namespace declarations", () => {
  it("keeps the root xmlns declaration", () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M0 0"/></svg>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("adds the xmlns declaration when the input never had one", () => {
    const out = sanitizeSvg('<svg viewBox="0 0 24 24"><path d="M0 0"/></svg>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("pins the value: a bogus xmlns is replaced, never passed through", () => {
    const out = sanitizeSvg('<svg xmlns="http://www.w3.org/1999/xhtml"><path d="M0 0"/></svg>');
    expect(out).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(out).not.toContain("1999/xhtml");
  });

  it("declares xmlns:xlink when a surviving xlink: attribute needs it", () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">' +
        '<defs><path id="p" d="M0 0"/></defs><use xlink:href="#p"/></svg>'
    );
    expect(out).toContain('xlink:href="#p"');
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it("declares xmlns:xlink even when the input used the prefix without declaring it", () => {
    // Undeclared-prefix input is already malformed, but the parser does not
    // track namespaces, so without this the sanitizer would hand back a
    // document no XML parser will accept.
    const out = sanitizeSvg('<svg><defs><path id="p" d="M0 0"/></defs><use xlink:href="#p"/></svg>');
    expect(out).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  });

  it("leaves xmlns:xlink out when nothing uses the prefix", () => {
    const out = sanitizeSvg('<svg xmlns:xlink="http://www.w3.org/1999/xlink"><path d="M0 0"/></svg>');
    expect(out).not.toContain("xmlns:xlink");
  });

  it("declares every prefix it goes on to use", () => {
    // The renderability contract in one assertion: no xlink: attribute may
    // survive into a document whose root does not declare that prefix.
    // (Checked by hand rather than with DOMParser, which workerd has not got.)
    const out = sanitizeSvg('<svg viewBox="0 0 24 24"><use xlink:href="#p"/></svg>');
    if (/\sxlink:/.test(out.replace(/^<svg[^>]*>/, ""))) {
      expect(out).toMatch(/^<svg[^>]*\sxmlns:xlink="http:\/\/www\.w3\.org\/1999\/xlink"/);
    }
    expect(out).toMatch(/^<svg[^>]*\sxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
});

// ---------------------------------------------------------------------------
// Additional adversarial vectors
// ---------------------------------------------------------------------------

describe("sanitizeSvg — adversarial vectors", () => {
  it("rejects an unrecognized/custom entity reference (XXE-style trick)", () => {
    expectThrows(
      '<!DOCTYPE svg [<!ENTITY xxe "http://evil.example/">]><svg><text>&xxe;</text></svg>'
    );
  });

  it("drops a doctype with an internal subset without executing it, and still rejects the later undefined entity", () => {
    // The internal subset itself must not break the tokenizer (it contains
    // its own '>' characters before the doctype's real close).
    expectThrows(
      '<!DOCTYPE svg [<!ENTITY foo "bar">]><svg><rect width="1"/>&foo;</svg>'
    );
  });

  it("does not let a numeric-entity-obfuscated javascript: scheme survive the href check", () => {
    // &#106; == 'j' -- decodes to "javascript:alert(1)" before the href check runs.
    const out = sanitizeSvg('<svg><use href="&#106;avascript:alert(1)"/></svg>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("&#106;");
  });

  it("neutralizes a <script> tag hidden in a CDATA section as literal text (not parsed as markup)", () => {
    const out = sanitizeSvg("<svg><text><![CDATA[<script>alert(1)</script>]]></text></svg>");
    // The CDATA content must survive only as escaped, inert text -- never as
    // a live <script> element.
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("still removes an actual <script> element that is itself wrapped in CDATA-adjacent markup", () => {
    const out = sanitizeSvg("<svg><script><![CDATA[alert(1)]]></script><rect width=\"1\"/></svg>");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("script");
    expect(out).toContain("<rect");
  });

  it("rejects malformed XML from a lone unescaped ampersand", () => {
    expectThrows("<svg><text>Tom & Jerry</text></svg>");
  });

  it("treats a namespaced but non-whitelisted element name as unknown and drops it", () => {
    const out = sanitizeSvg('<svg><a:script>alert(1)</a:script><rect width="1"/></svg>');
    expect(out).not.toContain("alert");
    expect(out).toContain("<rect");
  });

  it("drops a self-closing disallowed element with no children", () => {
    const out = sanitizeSvg('<svg><image href="#x"/><rect width="1"/></svg>');
    expect(out).not.toContain("<image");
    expect(out).toContain("<rect");
  });

  it("is a pure function — same input always yields the same output", () => {
    const input = '<svg><rect fill="url(#g1)" width="1"/></svg>';
    expect(sanitizeSvg(input)).toBe(sanitizeSvg(input));
  });
});

// ---------------------------------------------------------------------------
// Fix-round 1 (security review): two real bypasses found and closed.
// ---------------------------------------------------------------------------

describe("sanitizeSvg — fix-round 1: hasDisallowedUrl Unicode index bypass", () => {
  // U+0130 "İ" (LATIN CAPITAL LETTER I WITH DOT ABOVE) becomes 2 UTF-16 code
  // units ("i" + a combining dot above) under String.prototype.toLowerCase().
  // The original implementation searched for "url(" inside a *lowercased*
  // copy of the text but then used the index it found to read out of the
  // *original* (unlowercased) text. Padding the string with exactly 21 of
  // these characters shifts the computed position by 21 code units, landing
  // it on the embedded "#" inside "evil.example/x#y" instead of the
  // character right after "url(" — which made the check wrongly conclude
  // the reference was local and let the external URL through.
  const I_PAD = "İ".repeat(21); // "İ" x 21

  it("still flags an external url(...) in <style> content hidden behind Unicode-padding index drift", () => {
    const out = sanitizeSvg(
      `<svg><style>/*${I_PAD}*/rect{fill:url(http://evil.example/x#y)}</style><rect width="1"/></svg>`
    );
    expect(out).not.toContain("evil.example");
    expect(out).toMatch(/<style\s*\/>|<style><\/style>/);
  });

  it("still flags the same Unicode-padding trick in a fill attribute", () => {
    const out = sanitizeSvg(
      `<svg><rect fill="${I_PAD}url(http://evil.example/x#y)" width="1"/></svg>`
    );
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("fill=");
  });

  it("still keeps a plain url(#grad) reference (no regression)", () => {
    const out = sanitizeSvg('<svg><rect fill="url(#grad)" width="1"/></svg>');
    expect(out).toContain("url(#grad)");
  });

  it("treats url( #grad ) — whitespace around the fragment — as a local reference too", () => {
    const out = sanitizeSvg('<svg><rect fill="url( #grad )" width="1"/></svg>');
    expect(out).toContain("fill=");
    expect(out).toContain("#grad");
  });

  it("still flags uppercase URL(http://...) as an external reference", () => {
    const out = sanitizeSvg('<svg><rect fill="URL(http://evil.example/x)" width="1"/></svg>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("fill=");
  });
});

describe("sanitizeSvg — fix-round 1: attribute-name smuggling", () => {
  it("rejects an attribute name that smuggles a literal quote (font-family\"x=\"1\")", () => {
    expectThrows('<svg><rect font-family"x="1" width="1"/></svg>');
  });

  it("rejects an attribute name that smuggles a literal quote via the stroke- prefix", () => {
    expectThrows('<svg><rect stroke-"x="1" width="1"/></svg>');
  });

  it("still accepts legitimate font-*/stroke-* attribute names (no regression)", () => {
    const out = sanitizeSvg('<svg><rect font-family="Arial" stroke-width="2" width="1"/></svg>');
    expect(out).toContain('font-family="Arial"');
    expect(out).toContain('stroke-width="2"');
  });

  it("rejects a malformed closing-tag name carrying a smuggled quote", () => {
    expectThrows('<svg><rect width="1"></rect"x></svg>');
  });
});

// ---------------------------------------------------------------------------
// Final-review Finding 4: <style> url() veto missed @import.
// ---------------------------------------------------------------------------

describe("sanitizeSvg — final-review fix: <style> @import veto", () => {
  it("empties a <style> element whose text contains an @import (quoted form, no url())", () => {
    const out = sanitizeSvg('<svg><style>@import "https://evil.example/x.css";</style><rect width="1"/></svg>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("@import");
    expect(out).toMatch(/<style\s*\/>|<style><\/style>/);
  });

  it("empties a <style> element whose @import is uppercase/mixed-case", () => {
    const out = sanitizeSvg('<svg><style>@ImPoRT url(http://evil.example/x.css);</style><rect width="1"/></svg>');
    expect(out).not.toContain("evil.example");
    expect(out).toMatch(/<style\s*\/>|<style><\/style>/);
  });

  it("still keeps a normal <style> element with no url()/@import", () => {
    const out = sanitizeSvg('<svg><style>rect{fill:#fff}</style><rect width="1"/></svg>');
    expect(out).toContain("rect{fill:#fff}");
  });
});
