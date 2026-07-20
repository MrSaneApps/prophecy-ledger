import test from "node:test";
import assert from "node:assert/strict";
import { fetchHtml, isPrivateAddress, validatePublicUrl } from "../scanner/src/fetch.js";

const publicDns = async () => ["104.21.1.2", "2606:4700::6815:102"];
const html = (body = "ok", init = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html", ...init.headers }, ...init });

test("fetch guard rejects private IPv4/IPv6, credentials, schemes, and foreign hosts", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateAddress(address), true, address);
  assert.throws(() => validatePublicUrl("http://troyblackvideos.com/"), /https_required/);
  assert.throws(() => validatePublicUrl("https://user:pass@troyblackvideos.com/"), /credentials_forbidden/);
  assert.throws(() => validatePublicUrl("https://evil.example/"), /host_not_allowed/);
  assert.throws(() => validatePublicUrl("file:///etc/passwd"), /https_required/);
});

test("fetch guard blocks DNS rebinding and redirects outside the allowlist", async () => {
  await assert.rejects(() => fetchHtml("https://troyblackvideos.com/", { fetchImpl: async () => html(), dnsLookup: async () => ["127.0.0.1"] }), /dns_private_address/);
  await assert.rejects(() => fetchHtml("https://troyblackvideos.com/", {
    dnsLookup: publicDns,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
  }), /host_not_allowed/);
});

test("fetch guard validates redirects, byte limit, and content type", async () => {
  let calls = 0;
  const redirected = await fetchHtml("https://troyblackvideos.com/a", {
    dnsLookup: publicDns,
    fetchImpl: async () => ++calls === 1
      ? new Response(null, { status: 302, headers: { location: "/b" } })
      : html("done"),
  });
  assert.equal(redirected.html, "done");
  await assert.rejects(() => fetchHtml("https://troyblackvideos.com/", { dnsLookup: publicDns, maxBytes: 3, fetchImpl: async () => html("four") }), /response_too_large/);
  await assert.rejects(() => fetchHtml("https://troyblackvideos.com/", { dnsLookup: publicDns, fetchImpl: async () => new Response("{}", { headers: { "content-type": "application/json" } }) }), /wrong_content_type/);
});

test("fetch guard reports too many redirects, timeout, rate limit, and server errors as retryable where appropriate", async () => {
  await assert.rejects(() => fetchHtml("https://troyblackvideos.com/", {
    dnsLookup: publicDns, maxRedirects: 1,
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "/again" } }),
  }), /too_many_redirects/);
  await assert.rejects(() => fetchHtml("https://troyblackvideos.com/", {
    dnsLookup: publicDns, timeoutMs: 2,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  }), (error) => error.code === "fetch_timeout" && error.retryable);
  for (const status of [429, 503]) {
    await assert.rejects(() => fetchHtml("https://troyblackvideos.com/", { dnsLookup: publicDns, fetchImpl: async () => new Response("", { status }) }), (error) => error.status === status && error.retryable);
  }
});
