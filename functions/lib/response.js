export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function apiError(error, code, status = 400, details) {
  return json({ error, code, ...(details === undefined ? {} : { details }) }, status);
}

export async function readJson(request, maxBytes = 8_192) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("body_too_large");
  const text = await request.text();
  if (text.length > maxBytes) throw new Error("body_too_large");
  if (!text) throw new Error("body_required");
  try { return JSON.parse(text); } catch { throw new Error("invalid_json"); }
}
