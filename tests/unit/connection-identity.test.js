import { describe, expect, it } from "vitest";
import {
  credentialFingerprint,
  findCredentialDuplicates,
  tokenIdentity,
} from "../../src/lib/connectionIdentity.js";

const makeJwt = (payload) =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");

const conn = (over = {}) => ({
  id: "c1",
  provider: "workbuddy",
  name: "acc",
  authType: "oauth",
  ...over,
});

describe("credentialFingerprint", () => {
  it("is stable for the same credential and differs across credentials", () => {
    const a = conn({ accessToken: "x".repeat(40) });
    const b = conn({ id: "c2", accessToken: "x".repeat(40) });
    const c = conn({ id: "c3", accessToken: "y".repeat(40) });
    expect(credentialFingerprint(a)).toBe(credentialFingerprint(b));
    expect(credentialFingerprint(a)).not.toBe(credentialFingerprint(c));
  });

  it("falls back to the API key when there is no access token", () => {
    const a = conn({ accessToken: null, apiKey: "k".repeat(40) });
    const b = conn({ id: "c2", accessToken: null, apiKey: "k".repeat(40) });
    expect(credentialFingerprint(a)).toBe(credentialFingerprint(b));
    expect(credentialFingerprint(a)).not.toBeNull();
  });

  it("returns null for missing or too-short credentials", () => {
    expect(credentialFingerprint(conn({ accessToken: "" }))).toBeNull();
    expect(credentialFingerprint(conn({ accessToken: "short" }))).toBeNull();
    expect(credentialFingerprint(conn({}))).toBeNull();
  });
});

describe("tokenIdentity", () => {
  it("reads the upstream subject and email from a JWT", () => {
    const identity = tokenIdentity(conn({
      accessToken: makeJwt({ sub: "user-1", email: "a@example.com", name: "A" }),
    }));
    expect(identity).toEqual({ subject: "user-1", email: "a@example.com", name: "A" });
  });

  it("returns null for non-JWT credentials and tokens without a subject", () => {
    expect(tokenIdentity(conn({ accessToken: "opaque-key-value-long-enough" }))).toBeNull();
    expect(tokenIdentity(conn({ accessToken: makeJwt({ email: "a@example.com" }) }))).toBeNull();
    expect(tokenIdentity(conn({ accessToken: "eyJ.not-base64-json.at-all" }))).toBeNull();
    expect(tokenIdentity(conn({}))).toBeNull();
  });
});

describe("findCredentialDuplicates", () => {
  it("flags byte-identical credentials as same-token", () => {
    const token = "t".repeat(48);
    const a = conn({ id: "a", name: "first", accessToken: token });
    const b = conn({ id: "b", name: "second", accessToken: token });
    const dups = findCredentialDuplicates([a, b]);
    expect(dups.get("a")).toEqual({ of: { id: "b", name: "second" }, reason: "same-token" });
    expect(dups.get("b")).toEqual({ of: { id: "a", name: "first" }, reason: "same-token" });
  });

  it("flags the same upstream subject under different tokens as same-account", () => {
    // Distinct token strings (different jti) that resolve to one user.
    const a = conn({ id: "a", name: "first", accessToken: makeJwt({ sub: "user-1", jti: "t1" }) });
    const b = conn({ id: "b", name: "second", accessToken: makeJwt({ sub: "user-1", jti: "t2" }) });
    const dups = findCredentialDuplicates([a, b]);
    expect(dups.get("a")?.reason).toBe("same-account");
    expect(dups.get("a")?.of).toEqual({ id: "b", name: "second" });
  });

  it("leaves genuinely separate accounts alone", () => {
    const a = conn({ id: "a", name: "first", accessToken: makeJwt({ sub: "user-1" }) });
    const b = conn({ id: "b", name: "second", accessToken: makeJwt({ sub: "user-2" }) });
    expect(findCredentialDuplicates([a, b]).size).toBe(0);
  });

  it("never compares across providers", () => {
    const token = "t".repeat(48);
    const a = conn({ id: "a", provider: "workbuddy", accessToken: token });
    const b = conn({ id: "b", provider: "codex", accessToken: token });
    expect(findCredentialDuplicates([a, b]).size).toBe(0);
  });

  it("skips rows without a usable credential instead of matching them together", () => {
    const a = conn({ id: "a", name: "first", accessToken: "" });
    const b = conn({ id: "b", name: "second", accessToken: null });
    expect(findCredentialDuplicates([a, b]).size).toBe(0);
  });

  it("falls back to email and id when the sibling has no name", () => {
    const token = "t".repeat(48);
    const a = conn({ id: "a", name: "first", accessToken: token });
    const byEmail = conn({ id: "b", name: null, email: "b@example.com", accessToken: token });
    const byId = conn({ id: "b", name: null, email: null, accessToken: token });
    expect(findCredentialDuplicates([a, byEmail]).get("a")?.of.name).toBe("b@example.com");
    expect(findCredentialDuplicates([a, byId]).get("a")?.of.name).toBe("b");
  });
});
