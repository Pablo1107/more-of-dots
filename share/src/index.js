// Keeps the replays visitors of the hosted player choose to share, so a link can
// open them on any device. A replay is stored under the first 16 hex characters of
// its SHA-256, the same id the site's library gives it.
//   POST   /replays      body: the .rep file   → { id, token }  (no token if it was already shared)
//   GET    /replays/<id>                       → the .rep file
//   DELETE /replays/<id> Authorization: Bearer <token>
// It also downloads replays from links, such as Discord attachments, which most sites
// do not let a page read. It only ever returns a replay, so it cannot be used to
// download anything else:
//   GET    /fetch?url=<link>  → the .rep file
const MAX_SIZE = 1 << 20,
  MAX_TEXT = 32 << 20;
const ORIGINS = /^(https:\/\/aexer0e\.dev|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const ID = /^[0-9a-f]{16}$/;
const DISCORD = /^(cdn\.discordapp\.com|media\.discordapp\.net)$/;

/// The body of a response, or null when it is larger than MAX_SIZE.
async function readLimited(response) {
  if (Number(response.headers.get("Content-Length")) > MAX_SIZE) return null;
  const parts = [];
  let total = 0;
  for await (const part of response.body ?? []) {
    total += part.length;
    if (total > MAX_SIZE) return null;
    parts.push(part);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) bytes.set(part, at), (at += part.length);
  return bytes;
}

const hex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));

/// Whether the bytes are a War of Dots replay: gzip or plain JSON with a map, as
/// the site reads them. Checked without parsing, which would cost too much time.
async function isReplay(bytes) {
  let text = "";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))) {
        text += decoder.decode(chunk, { stream: true });
        if (text.length > MAX_TEXT) return false;
      }
    } catch {
      return false;
    }
  } else text = new TextDecoder().decode(bytes);
  text = text.trim();
  return text.startsWith("{") && text.endsWith("}") && (text.includes('"map"') || text.includes('"custom_map"'));
}

function respond(request, body, status = 200, headers = {}) {
  const origin = request.headers.get("Origin") ?? "";
  const cors = ORIGINS.test(origin)
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "86400" }
    : {};
  const json = body !== null && !(body instanceof Uint8Array);
  return new Response(json ? JSON.stringify(body) : body, {
    status,
    headers: { Vary: "Origin", ...(json ? { "Content-Type": "application/json" } : {}), ...cors, ...headers },
  });
}
const failure = (request, status, error) => respond(request, { error }, status);

async function upload(request, env) {
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.UPLOADS.limit({ key: address })).success)
    return failure(request, 429, "Too many replays shared at once. Try again in a minute.");
  if (Number(request.headers.get("Content-Length")) > MAX_SIZE) return failure(request, 413, "This replay is too large to share.");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_SIZE) return failure(request, 413, "This replay is too large to share.");
  if (!bytes.length || !(await isReplay(bytes))) return failure(request, 400, "This is not a War of Dots replay.");
  const id = hex((await sha256(bytes)).slice(0, 8));
  if (await env.DB.prepare("SELECT 1 FROM replays WHERE id = ?").bind(id).first()) return respond(request, { id });
  const token = hex(crypto.getRandomValues(new Uint8Array(16)));
  const owner = hex(await sha256(new TextEncoder().encode(token)));
  const { meta } = await env.DB.prepare("INSERT INTO replays (id, data, size, owner, created) VALUES (?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING")
    .bind(id, bytes, bytes.length, owner, Date.now())
    .run();
  return meta.changes ? respond(request, { id, token }, 201) : respond(request, { id });
}

/// Downloads a replay from a link. Only files up to MAX_SIZE that are replays are returned.
async function fetchLink(request, env, link) {
  let url;
  try {
    url = new URL(link ?? "");
  } catch {
    return failure(request, 400, "That is not a link.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === new URL(request.url).hostname)
    return failure(request, 400, "That is not a link.");
  const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.UPLOADS.limit({ key: `fetch:${address}` })).success)
    return failure(request, 429, "Too many links opened at once. Try again in a minute.");
  let response;
  try {
    response = await fetch(url);
  } catch {
    return failure(request, 502, "Could not download this link.");
  }
  if (!response.ok)
    return DISCORD.test(url.hostname)
      ? failure(request, 404, "This link has expired or the file was removed. Copy the link from Discord again.")
      : failure(request, 404, "Could not download this link.");
  const bytes = await readLimited(response);
  if (!bytes) return failure(request, 413, "This file is too large to be a replay.");
  if (!bytes.length || !(await isReplay(bytes))) return failure(request, 400, "This is not a War of Dots replay.");
  return respond(request, bytes, 200, { "Content-Type": "application/octet-stream" });
}

async function download(request, env, id) {
  const row = await env.DB.prepare("SELECT data FROM replays WHERE id = ?").bind(id).first();
  if (!row) return failure(request, 404, "This replay is no longer shared.");
  return respond(request, new Uint8Array(row.data), 200, { "Content-Type": "application/octet-stream", "Cache-Control": "public, max-age=300" });
}

async function remove(request, env, id) {
  const token = /^Bearer ([0-9a-f]{32})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token) return failure(request, 401, "Only the browser that shared this replay can stop sharing it.");
  const owner = hex(await sha256(new TextEncoder().encode(token)));
  const { meta } = await env.DB.prepare("DELETE FROM replays WHERE id = ? AND owner = ?").bind(id, owner).run();
  return meta.changes ? respond(request, null, 204) : failure(request, 404, "This replay is no longer shared.");
}

export default {
  async fetch(request, env) {
    const { pathname, searchParams } = new URL(request.url);
    const [, collection, id, extra] = pathname.split("/");
    if (request.method === "OPTIONS") return respond(request, null, 204);
    if (collection === "fetch" && id === undefined)
      return request.method === "GET" ? await fetchLink(request, env, searchParams.get("url")).catch((error) => {
        console.error(error);
        return failure(request, 502, "Could not download this link.");
      }) : failure(request, 405, "Method not allowed.");
    if (collection !== "replays" || extra !== undefined) return failure(request, 404, "Not found.");
    try {
      if (id === undefined || id === "") return request.method === "POST" ? await upload(request, env) : failure(request, 405, "Method not allowed.");
      if (!ID.test(id)) return failure(request, 404, "This replay is no longer shared.");
      if (request.method === "GET") return await download(request, env, id);
      if (request.method === "DELETE") return await remove(request, env, id);
      return failure(request, 405, "Method not allowed.");
    } catch (error) {
      console.error(error);
      return failure(request, 500, "The replay service is not available right now.");
    }
  },
};
