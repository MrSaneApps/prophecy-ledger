const keyCache = new Map();
const textEncoder = new TextEncoder();

function configuredDemoPrincipals(env) {
  const principals = [];
  for (let index = 1; index <= 8; index += 1) {
    const id = String(env[`DEMO_REVIEWER_${index}_ID`] || "").trim();
    const token = String(env[`DEMO_REVIEWER_${index}_TOKEN`] || "");
    if (id && token) principals.push({ id, token });
  }
  return principals;
}

function tokenPrincipal(principals, token) {
  if (!token) return null;
  const match = principals.find((principal) => principal.token === token);
  return match ? { reviewerId: match.id } : null;
}

function isLoopback(url) {
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
}

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("jwt_encoding_invalid");
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeJson(value) {
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength > 16_384) throw new Error("jwt_part_too_large");
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error("jwt_json_invalid"); }
}

function accessConfig(env) {
  const issuer = String(env.CF_ACCESS_ISSUER || "").replace(/\/$/, "");
  const audience = String(env.CF_ACCESS_AUD || "").trim();
  const jwksUrl = String(env.CF_ACCESS_JWKS_URL || "").trim();
  if (!issuer || !audience || !jwksUrl) throw new Error("access_configuration_missing");
  const issuerUrl = new URL(issuer), keysUrl = new URL(jwksUrl);
  if (issuerUrl.protocol !== "https:" || keysUrl.protocol !== "https:" ||
      issuerUrl.username || issuerUrl.password || keysUrl.username || keysUrl.password) {
    throw new Error("access_configuration_invalid");
  }
  return { issuer, audience, jwksUrl: keysUrl.toString() };
}

async function fetchJwk(config, kid, fetchImpl) {
  const cacheKey = `${config.jwksUrl}\0${kid}`;
  const cached = keyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.key;

  const response = await fetchImpl(config.jwksUrl, {
    headers: { accept: "application/json" }, redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("access_jwks_redirect_forbidden");
  }
  if (!response.ok) throw new Error("access_jwks_unavailable");
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > 131_072) throw new Error("access_jwks_too_large");
  const text = await response.text();
  if (text.length > 131_072) throw new Error("access_jwks_too_large");
  let document;
  try { document = JSON.parse(text); } catch { throw new Error("access_jwks_invalid"); }
  const candidates = Array.isArray(document?.keys) ? document.keys : [];
  const jwk = candidates.find((item) => item?.kid === kid && item?.kty === "RSA" &&
    (!item.alg || item.alg === "RS256") && (!item.use || item.use === "sig"));
  if (!jwk) throw new Error("access_signing_key_not_found");
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  keyCache.set(cacheKey, { key, expiresAt: Date.now() + 300_000 });
  return key;
}

function validateClaims(payload, config, nowSeconds) {
  const audiences = Array.isArray(payload?.aud) ? payload.aud : [payload?.aud];
  if (payload?.iss !== config.issuer) throw new Error("access_issuer_invalid");
  if (!audiences.includes(config.audience)) throw new Error("access_audience_invalid");
  if (payload?.type !== "app") throw new Error("access_token_type_invalid");
  if (!Number.isFinite(payload?.exp) || payload.exp <= nowSeconds) throw new Error("access_token_expired");
  if (payload.nbf != null && (!Number.isFinite(payload.nbf) || payload.nbf > nowSeconds + 30)) {
    throw new Error("access_token_not_yet_valid");
  }
  if (payload.iat != null && (!Number.isFinite(payload.iat) || payload.iat > nowSeconds + 30)) {
    throw new Error("access_token_issued_in_future");
  }
  if (typeof payload.sub !== "string" || !payload.sub.trim() || payload.sub.length > 512) {
    throw new Error("access_subject_missing");
  }
}

async function stableReviewerId(issuer, subject) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(`${issuer}\0${subject}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `reviewer_${hex}`;
}

export async function verifyAccessJwt(token, env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!token || token.length > 16_384) throw new Error("access_token_missing_or_too_large");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("access_token_malformed");
  const header = decodeJson(parts[0]), payload = decodeJson(parts[1]);
  if (header?.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) {
    throw new Error("access_algorithm_or_key_invalid");
  }
  const config = accessConfig(env);
  validateClaims(payload, config, Math.floor(now / 1000));
  const key = await fetchJwk(config, header.kid, fetchImpl);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, decodeBase64Url(parts[2]), textEncoder.encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("access_signature_invalid");
  return {
    reviewerId: await stableReviewerId(config.issuer, payload.sub),
    mode: "cloudflare_access",
  };
}

export async function resolveReviewerPrincipal(request, env) {
  const url = new URL(request.url);
  if (isLoopback(url) && String(env.REVIEW_DEMO_MODE) === "1") {
    const principal = tokenPrincipal(
      configuredDemoPrincipals(env), request.headers.get("x-demo-reviewer-token"),
    );
    return principal ? { ...principal, mode: "local_non_deployable_demo" } : null;
  }
  if (isLoopback(url)) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try { return await verifyAccessJwt(token, env); } catch (error) {
    console.error("access_verification_failed", {
      code: error instanceof Error ? error.message : "unknown_error",
    });
    return null;
  }
}
