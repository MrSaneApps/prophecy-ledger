export const ALLOWED_HOSTS = new Set(["troyblackvideos.com", "www.troyblackvideos.com"]);

export class ScannerFetchError extends Error {
  constructor(code, { retryable = false, status = null } = {}) {
    super(code);
    this.name = "ScannerFetchError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

function ipv4Number(value) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((sum, part) => sum * 256 + Number(part), 0) >>> 0;
}

export function isPrivateAddress(value) {
  const address = value.toLowerCase().replace(/^\[|\]$/g, "");
  const ip = ipv4Number(address);
  if (ip !== null) {
    return (ip >>> 24) === 10 || (ip >>> 24) === 127 || (ip >>> 16) === 0xa9fe ||
      (ip >>> 20) === 0xac1 || (ip >>> 16) === 0xc0a8 || (ip >>> 24) === 0 ||
      (ip >>> 28) === 14 || ip === 0xffffffff;
  }
  if (!address.includes(":")) return false;
  if (address === "::" || address === "::1") return true;
  if (address.startsWith("fc") || address.startsWith("fd") || /^fe[89ab]/.test(address)) return true;
  const mapped = address.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  return mapped ? isPrivateAddress(mapped) : false;
}

export function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new ScannerFetchError("invalid_url"); }
  if (url.protocol !== "https:") throw new ScannerFetchError("https_required");
  if (url.username || url.password) throw new ScannerFetchError("credentials_forbidden");
  if (!ALLOWED_HOSTS.has(url.hostname.toLowerCase())) throw new ScannerFetchError("host_not_allowed");
  if (isPrivateAddress(url.hostname)) throw new ScannerFetchError("private_address");
  url.hash = "";
  return url;
}

async function dnsJson(hostname, type) {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
  });
  if (!response.ok) throw new ScannerFetchError("dns_lookup_failed", { retryable: true });
  const payload = await response.json();
  return (payload.Answer || []).filter((answer) => answer.type === (type === "A" ? 1 : 28)).map((answer) => answer.data);
}

export async function resolvePublicDns(hostname) {
  const [v4, v6] = await Promise.all([dnsJson(hostname, "A"), dnsJson(hostname, "AAAA")]);
  return [...v4, ...v6];
}

async function assertPublicDns(hostname, dnsLookup) {
  const addresses = await dnsLookup(hostname);
  if (!Array.isArray(addresses) || addresses.length === 0) throw new ScannerFetchError("dns_no_public_address", { retryable: true });
  if (addresses.some(isPrivateAddress)) throw new ScannerFetchError("dns_private_address");
}

async function readLimited(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new ScannerFetchError("response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new ScannerFetchError("response_too_large"); }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

export async function fetchHtml(rawUrl, {
  fetchImpl = fetch,
  dnsLookup = resolvePublicDns,
  timeoutMs = 15_000,
  maxBytes = 2 * 1024 * 1024,
  maxRedirects = 4,
} = {}) {
  let current = validatePublicUrl(rawUrl);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    await assertPublicDns(current.hostname, dnsLookup);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/html,application/xhtml+xml", "user-agent": "ProphecyLedgerResearchBot/0.1 (+https://prophecy-ledger.pages.dev)" },
      });
    } catch (error) {
      if (error?.name === "AbortError") throw new ScannerFetchError("fetch_timeout", { retryable: true });
      throw new ScannerFetchError("network_error", { retryable: true });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === maxRedirects) throw new ScannerFetchError("too_many_redirects");
      const location = response.headers.get("location");
      if (!location) throw new ScannerFetchError("redirect_without_location");
      current = validatePublicUrl(new URL(location, current).toString());
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      throw new ScannerFetchError(`upstream_${response.status}`, { retryable: true, status: response.status });
    }
    if (!response.ok) throw new ScannerFetchError(`upstream_${response.status}`, { status: response.status });
    const type = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (!type || !["text/html", "application/xhtml+xml"].includes(type)) throw new ScannerFetchError("wrong_content_type");
    return { url: current.toString(), status: response.status, html: await readLimited(response, maxBytes) };
  }
  throw new ScannerFetchError("too_many_redirects");
}
