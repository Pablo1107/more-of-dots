// Replays a visitor adds are kept in this browser's IndexedDB and never uploaded.
// A replay is stored once, under the start of its SHA-256, with the details the
// home page shows so the list never has to open the files.
const DATABASE = "wod-replays",
  STORE = "replays";

let database;
function open() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}
async function run(mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export const listReplays = () => run("readonly", (store) => store.getAll());
export const getReplay = (id) => run("readonly", (store) => store.get(id));
export const removeReplay = (id) => run("readwrite", (store) => store.delete(id));

async function text(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/// The players, length, version and map picture of a replay, read without simulating it.
export async function readHeader(bytes) {
  let replay;
  try {
    replay = JSON.parse(await text(bytes));
  } catch {
    throw new Error("This is not a War of Dots replay.");
  }
  if (!replay || typeof replay !== "object" || !("map" in replay || "custom_map" in replay))
    throw new Error("This is not a War of Dots replay.");
  const map = replay.map && typeof replay.map === "object" ? replay.map : replay.custom_map;
  const teams = (replay.player_usernames ?? replay.player_names ?? []).map((team) =>
    (Array.isArray(team) ? team : [team]).map((player) => (typeof player === "string" ? player : player?.username ?? "")),
  );
  const surface = typeof map?.map_surface === "string" ? map.map_surface : null;
  // Official maps are only named: by their image in the game (assets/fahero_maps/map4.png) or by number.
  const named = replay.map && typeof replay.map === "object" ? replay.map.path : replay.map;
  return {
    players: teams.map((team) => team.join(" & ")),
    version: replay.version ?? null,
    frames: Number(replay.end) || 0,
    thumb: surface ? `data:image/png;base64,${surface}` : null,
    mapRef: !surface && (typeof named === "string" || typeof named === "number") ? String(named).trim() : null,
  };
}

/// Adds the details later versions of the site read to a replay kept by an earlier one.
export async function refreshDetails(record) {
  const updated = { ...record, ...(await readHeader(new Uint8Array(await record.blob.arrayBuffer()))) };
  await run("readwrite", (store) => store.put(updated));
  return updated;
}

/// Keeps a replay file. Resolves to `{ record, added }`; `added` is false when
/// the same file was already kept.
export async function addReplay(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const id = [...digest.slice(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const existing = await getReplay(id);
  if (existing) return { record: existing, added: false };
  const record = { id, name: file.name, size: bytes.length, added: Date.now(), ...(await readHeader(bytes)), blob: new Blob([bytes]) };
  await run("readwrite", (store) => store.put(record));
  // Ask the browser not to clear the library when it runs low on space.
  void navigator.storage?.persist?.().catch(() => {});
  return { record, added: true };
}
