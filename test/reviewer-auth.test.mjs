import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { resolveReviewerPrincipal, verifyAccessJwt } from "../functions/lib/reviewer-auth.js";

const base64url = (value) => Buffer.from(value).toString("base64url");

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = `key-${randomUUID()}`;
  return {
    kid,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
    sign(payload) {
      const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
      const body = base64url(JSON.stringify(payload));
      const signingInput = `${header}.${body}`;
      const signature = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey).toString("base64url");
      return `${signingInput}.${signature}`;
    },
  };
}

function accessFixture(overrides = {}) {
  const keys = signer();
  const now = Math.floor(Date.now() / 1000);
  const env = {
    CF_ACCESS_ISSUER: "https://ledger-team.cloudflareaccess.com",
    CF_ACCESS_AUD: "review-app-audience",
    CF_ACCESS_JWKS_URL: "https://ledger-team.cloudflareaccess.com/cdn-cgi/access/certs",
  };
  const payload = {
    iss: env.CF_ACCESS_ISSUER, aud: [env.CF_ACCESS_AUD], sub: "access-user-123",
    type: "app", iat: now - 10, nbf: now - 10, exp: now + 300, ...overrides,
  };
  const fetchImpl = async () => new Response(JSON.stringify({ keys: [keys.jwk] }), {
    status: 200, headers: { "content-type": "application/json" },
  });
  return { env, token: keys.sign(payload), fetchImpl, now };
}

test("valid Cloudflare Access JWT verifies signature, issuer, audience, expiry, and stable subject", async () => {
  const fixture = accessFixture();
  const first = await verifyAccessJwt(fixture.token, fixture.env, {
    fetchImpl: fixture.fetchImpl, now: fixture.now * 1000,
  });
  const second = await verifyAccessJwt(fixture.token, fixture.env, {
    fetchImpl: fixture.fetchImpl, now: fixture.now * 1000,
  });
  assert.equal(first.mode, "cloudflare_access");
  assert.match(first.reviewerId, /^reviewer_[a-f0-9]{64}$/);
  assert.equal(first.reviewerId, second.reviewerId);
});

test("Access JWT fails closed for wrong issuer, audience, expiry, and signature", async () => {
  for (const overrides of [
    { iss: "https://other.cloudflareaccess.com" },
    { aud: ["wrong-audience"] },
    { exp: 1 },
  ]) {
    const fixture = accessFixture(overrides);
    await assert.rejects(() => verifyAccessJwt(fixture.token, fixture.env, {
      fetchImpl: fixture.fetchImpl, now: fixture.now * 1000,
    }), /access_(issuer_invalid|audience_invalid|token_expired)/);
  }
  const fixture = accessFixture();
  const tampered = `${fixture.token.slice(0, -2)}aa`;
  await assert.rejects(() => verifyAccessJwt(tampered, fixture.env, {
    fetchImpl: fixture.fetchImpl, now: fixture.now * 1000,
  }), /access_signature_invalid/);
});

test("Access JWKS lookup uses the edge-supported manual redirect mode and rejects redirects", async () => {
  const fixture = accessFixture();
  let redirectMode = "";
  const fetchImpl = async (_url, options) => {
    redirectMode = options.redirect;
    return new Response(null, { status: 302, headers: { location: "https://example.com/keys" } });
  };
  await assert.rejects(() => verifyAccessJwt(fixture.token, fixture.env, {
    fetchImpl, now: fixture.now * 1000,
  }), /access_jwks_redirect_forbidden/);
  assert.equal(redirectMode, "manual");
});

test("demo identity is accepted only on loopback and production bearer tokens are ignored", async () => {
  const env = {
    REVIEW_DEMO_MODE: "1", DEMO_REVIEWER_1_ID: "demo-one", DEMO_REVIEWER_1_TOKEN: "demo-secret",
  };
  const local = await resolveReviewerPrincipal(new Request("http://127.0.0.1/api/review/queue", {
    headers: { "x-demo-reviewer-token": "demo-secret" },
  }), env);
  assert.deepEqual(local, { reviewerId: "demo-one", mode: "local_non_deployable_demo" });
  assert.equal(await resolveReviewerPrincipal(new Request("https://ledger.example/api/review/queue", {
    headers: { "x-demo-reviewer-token": "demo-secret" },
  }), env), null);
  assert.equal(await resolveReviewerPrincipal(new Request("https://ledger.example/api/review/queue", {
    headers: { authorization: "Bearer old-static-token" },
  }), env), null);
  assert.equal(await resolveReviewerPrincipal(new Request("http://localhost/api/review/queue", {
    headers: { "x-demo-reviewer-token": "demo-secret" },
  }), { ...env, REVIEW_DEMO_MODE: "0" }), null);
});
