import { describe, it, expect } from "vitest";
import { signTicket, verifyTicket, TICKET_TTL_SECONDS } from "../../src/tickets.js";
import { HttpError } from "../../src/auth.js";

const SECRET = "test-ticket-secret";
const claims = () => ({
  draft_id: "ab12cd34",
  kind: "login_bg",
  size: 1232488,
  sha256: "a".repeat(64),
  exp: Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS,
});

describe("tickets", () => {
  it("round-trips the claims it was given", async () => {
    const c = claims();
    const got = await verifyTicket(SECRET, await signTicket(SECRET, c));
    expect(got).toEqual(c);
  });

  it("rejects a ticket signed with another secret", async () => {
    const token = await signTicket("other-secret", claims());
    await expect(verifyTicket(SECRET, token)).rejects.toThrow(HttpError);
  });

  it("rejects a tampered payload", async () => {
    const token = await signTicket(SECRET, claims());
    const [body, sig] = token.split(".");
    const decoded = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    decoded.size = 10;
    const forged =
      btoa(JSON.stringify(decoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") +
      "." + sig;
    await expect(verifyTicket(SECRET, forged)).rejects.toThrow(HttpError);
  });

  it("rejects an expired ticket", async () => {
    const c = { ...claims(), exp: Math.floor(Date.now() / 1000) - 1 };
    await expect(verifyTicket(SECRET, await signTicket(SECRET, c))).rejects.toThrow(HttpError);
  });

  it("rejects malformed tokens", async () => {
    for (const bad of ["", "nodot", "a.b.c", "!!!.???"]) {
      await expect(verifyTicket(SECRET, bad)).rejects.toThrow(HttpError);
    }
  });
});
