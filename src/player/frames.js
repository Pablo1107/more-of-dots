// Playback frames in the chunk format of docs/replay-frames.md. Hosts keep each
// chunk as it was written and answer `replay_chunk` with it; the render worker
// inflates and decodes it into the state records the player draws.
export const BINARY_FRAMES = 1,
  JSON_LINES = 2;
const MAGIC = "WODFRM1\n",
  STATIC_RECORD = 1,
  CHUNK_RECORD = 2,
  DEATH_WINDOW = 100;
const unitTypes = ["infantry", "tank", "motorised"];
const terrains = ["plain", "forest", "sand", "river", "mountain", "bridge", "hill", "snow", "mud", "city"];
const text = new TextDecoder();

/// Frame numbers and sound cues, readable without inflating the frames.
export function chunkHeader(payload) {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
    count = view.getUint32(1, true);
  if (payload.byteLength < 5 + 12 * count) throw new Error("Incomplete replay chunk.");
  const column = (at) => Array.from({ length: count }, (_, i) => view.getUint32(at + 4 * i, true));
  return {
    encoding: payload[0],
    frames: column(5),
    fighting: column(5 + 4 * count),
    produced: column(5 + 8 * count),
    data: 5 + 12 * count,
  };
}

/// Splits the engine's output stream into its static record and chunks, across
/// arbitrary write boundaries.
export class RecordReader {
  constructor(handlers) {
    this.handlers = handlers;
    this.pending = new Uint8Array(0);
    this.started = false;
  }
  push(bytes) {
    if (this.pending.length) {
      const joined = new Uint8Array(this.pending.length + bytes.length);
      joined.set(this.pending);
      joined.set(bytes, this.pending.length);
      bytes = joined;
    }
    let at = 0;
    if (!this.started) {
      if (bytes.length < MAGIC.length) return void (this.pending = bytes);
      if (text.decode(bytes.subarray(0, MAGIC.length)) !== MAGIC) throw new Error("The replay engine wrote an unknown format.");
      this.started = true;
      at = MAGIC.length;
    }
    while (bytes.length - at >= 5) {
      const length = new DataView(bytes.buffer, bytes.byteOffset + at + 1, 4).getUint32(0, true);
      if (bytes.length - at - 5 < length) break;
      const kind = bytes[at],
        payload = bytes.slice(at + 5, at + 5 + length);
      at += 5 + length;
      if (kind === STATIC_RECORD) this.handlers.static(JSON.parse(text.decode(payload)));
      else if (kind === CHUNK_RECORD) this.handlers.chunk(payload);
    }
    this.pending = bytes.slice(at);
  }
  // The stream must end on a record boundary.
  finish() {
    if (this.pending.length || !this.started) throw new Error("The replay engine output ended early.");
  }
}

const piped = (bytes, stream) =>
  new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then((buffer) => new Uint8Array(buffer));

/// A chunk of JSONL state records, for replays that were simulated earlier.
export async function jsonChunk(lines, frames, fighting, produced) {
  const body = await piped(lines.join("\n"), new CompressionStream("deflate-raw")),
    count = frames.length,
    payload = new Uint8Array(5 + 12 * count + body.length),
    view = new DataView(payload.buffer);
  payload[0] = JSON_LINES;
  view.setUint32(1, count, true);
  [frames, fighting, produced].forEach((column, c) =>
    column.forEach((value, i) => view.setUint32(5 + 4 * (c * count + i), value, true)),
  );
  payload.set(body, 5 + 12 * count);
  return payload;
}

/// `replay_chunk` answers with the index of the chunk's first frame, then the chunk.
export async function decodeChunk(buffer, staticRecord) {
  const start = new DataView(buffer).getUint32(0, true),
    payload = new Uint8Array(buffer, 4),
    header = chunkHeader(payload),
    data = await piped(payload.subarray(header.data), new DecompressionStream("deflate-raw"));
  const frames =
    header.encoding === JSON_LINES
      ? text.decode(data).split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : decodeFrames(data, header, staticRecord);
  if (frames.length !== header.frames.length) throw new Error("Replay chunk frames do not match its index.");
  return { start, frames, bytes: data.length };
}

function decodeFrames(bytes, header, staticRecord) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    cityPositions = staticRecord.static_core?.city_positions || [];
  let at = 0;
  const u8 = () => bytes[at++],
    u16 = () => ((at += 2), view.getUint16(at - 2, true)),
    u32 = () => ((at += 4), view.getUint32(at - 4, true)),
    f32 = () => ((at += 4), view.getFloat32(at - 4, true)),
    f64 = () => ((at += 8), view.getFloat64(at - 8, true)),
    vec = (read) => [read(), read()];
  // Each frame repeats only what changed since the previous one in this chunk.
  const paths = new Map(),
    deaths = [],
    states = [];
  let contours = [],
    core = null;
  for (let n = 0; n < header.frames.length; n++) {
    const frame = u32(),
      dots = [],
      directions = [];
    for (let i = 0, count = u16(); i < count; i++) {
      const id = u16(),
        color = u8(),
        type = unitTypes[u8()],
        flags = u8(),
        terrain = terrains[u8()],
        water_timer = u16(),
        ship_timer = u16(),
        position = vec(f32),
        health = f64(),
        max_health = f32(),
        morale = f32();
      directions.push({
        id,
        facing: vec(f32),
        first_visual: vec(f32),
        visual: vec(f32),
        first_vibration: f32(),
        second_vibration: f32(),
      });
      const length = u16();
      if (length !== 0xffff) paths.set(id, Array.from({ length }, () => vec(f32)));
      dots.push({
        id,
        position,
        color,
        type,
        health,
        max_health,
        morale,
        water_timer,
        ship_timer,
        in_city: !!(flags & 2),
        healing: !!(flags & 4),
        zrtyqz: terrain,
        path: paths.get(id) ?? [],
        ship: !!(flags & 1),
      });
    }
    for (let i = 0, count = u16(); i < count; i++)
      deaths.push({ frame: u32(), color: u8(), type: unitTypes[u8()], ship: !!u8(), position: vec(f32) });
    const changes = u8();
    if (changes & 1)
      contours = Array.from({ length: u8() }, () =>
        Array.from({ length: u16() }, () => Array.from({ length: u32() }, () => vec(f64))),
      );
    if (changes & 2) {
      const length = u32();
      core = JSON.parse(text.decode(bytes.subarray(at, at + length)));
      at += length;
    }
    if (!core) throw new Error("Replay chunk does not start with a complete frame.");
    states.push({
      kind: "state",
      frame,
      audio: [header.fighting[n], header.produced[n]],
      dots,
      core: {
        frame,
        economy: core.economy,
        troop_casualties: core.troop_casualties,
        strength: core.strength,
        capitals: core.capitals,
        city_positions: cityPositions,
        cities: cityPositions.map((position, i) => ({ position, color: core.city_colors[i] })),
        dead_dots: deaths.filter((death) => frame - death.frame < DEATH_WINDOW),
      },
      render: { contours, directions },
    });
  }
  if (at !== bytes.length) throw new Error("Replay chunk has unread data.");
  return states;
}
