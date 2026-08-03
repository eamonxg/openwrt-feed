import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../../src/sanitize-svg.js";

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
    expect(out).toMatch(/<svg><g><path d="M0 0"\/><\/g><\/svg>/);
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
