import test from "node:test";
import assert from "node:assert/strict";
import { RecordReader, chunkHeader, decodeChunk, jsonChunk, BINARY_FRAMES } from "../src/player/frames.js";

// Little-endian writer for hand-built chunks.
function bytes(build) {
  const parts = [];
  const put = (size, write) => {
    const view = new DataView(new ArrayBuffer(size));
    write(view);
    parts.push(new Uint8Array(view.buffer));
  };
  build({
    u8: (v) => put(1, (d) => d.setUint8(0, v)),
    u16: (v) => put(2, (d) => d.setUint16(0, v, true)),
    u32: (v) => put(4, (d) => d.setUint32(0, v, true)),
    f32: (v) => put(4, (d) => d.setFloat32(0, v, true)),
    f64: (v) => put(8, (d) => d.setFloat64(0, v, true)),
    raw: (v) => parts.push(v),
  });
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  parts.reduce((offset, part) => (result.set(part, offset), offset + part.length), 0);
  return result;
}
const deflate = async (data) =>
  new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
// What `replay_chunk` returns: the start index, then the chunk.
const answer = (start, payload) => bytes((w) => (w.u32(start), w.raw(payload))).buffer;
const record = (kind, payload) => bytes((w) => (w.u8(kind), w.u32(payload.length), w.raw(payload)));
const staticRecord = { kind: "static", static_core: { map_size: [1600, 900], city_positions: [[100, 200], [300, 400]] } };

test("records are read across any write boundaries", () => {
  const seen = [];
  const reader = new RecordReader({ static: (r) => seen.push(r.kind), chunk: (p) => seen.push([...p]) });
  const stream = bytes((w) => {
    w.raw(new TextEncoder().encode("WODFRM1\n"));
    w.raw(record(1, new TextEncoder().encode(JSON.stringify(staticRecord))));
    w.raw(record(2, new Uint8Array([1, 2, 3])));
    w.raw(record(7, new Uint8Array([9])));
    w.raw(record(2, new Uint8Array([])));
  });
  for (const byte of stream) reader.push(new Uint8Array([byte]));
  reader.finish();
  assert.deepEqual(seen, ["static", [1, 2, 3], []]);
  const cut = new RecordReader({ static() {}, chunk() {} });
  cut.push(stream.subarray(0, stream.length - 3));
  assert.throws(() => cut.finish());
  assert.throws(() => new RecordReader({}).push(new TextEncoder().encode("MODRPS2\n")));
});

test("JSON lines chunks keep each record and its sound cues", async () => {
  const rows = [{ kind: "state", frame: 30, dots: [{ name: "العراق" }] }, { kind: "state", frame: 31 }];
  const payload = await jsonChunk(rows.map((row) => JSON.stringify(row)), [30, 31], [5, 0], [1, 2]);
  assert.deepEqual(chunkHeader(payload).frames, [30, 31]);
  assert.deepEqual(chunkHeader(payload).fighting, [5, 0]);
  assert.deepEqual(chunkHeader(payload).produced, [1, 2]);
  const chunk = await decodeChunk(answer(12, payload), staticRecord);
  assert.equal(chunk.start, 12);
  assert.deepEqual(chunk.frames, rows);
});

test("binary frames repeat paths, contours and the economy from the previous frame", async () => {
  const core = { economy: { fields: { zrtyz: [10, 20] } }, troop_casualties: [1, 0], strength: [3, 4], capitals: [], city_colors: [1, 0] };
  const unit = (w, x, path) => {
    w.u16(7), w.u8(1), w.u8(2), w.u8(1 | 4), w.u8(1), w.u16(0), w.u16(12);
    w.f32(x), w.f32(50), w.f64(49.999), w.f32(100), w.f32(80);
    for (const v of [1, 0, 0.5, 0.5, 0, 1, 0.25, -0.25]) w.f32(v);
    if (path) (w.u16(path.length), path.forEach(([px, py]) => (w.f32(px), w.f32(py))));
    else w.u16(0xffff);
  };
  const frames = bytes((w) => {
    // A complete frame: one unit with a path, one fading death, contours and core.
    w.u32(40), w.u16(1), unit(w, 10, [[20, 30]]);
    w.u16(1), w.u32(39), w.u8(0), w.u8(1), w.u8(0), w.f32(5), w.f32(6);
    w.u8(3), w.u8(1), w.u16(1), w.u32(2), w.f64(0.5), w.f64(1.25), w.f64(2), w.f64(3);
    const text = new TextEncoder().encode(JSON.stringify(core));
    w.u32(text.length), w.raw(text);
    // The next frame moves the unit and adds a death; nothing else changes.
    w.u32(41), w.u16(1), unit(w, 11, null);
    w.u16(1), w.u32(40), w.u8(1), w.u8(0), w.u8(1), w.f32(7), w.f32(8);
    w.u8(0);
  });
  const body = await deflate(frames);
  const payload = bytes((w) => {
    w.u8(BINARY_FRAMES), w.u32(2);
    [40, 41, 3, 0, 1, 2].forEach((v) => w.u32(v));
    w.raw(body);
  });
  const [first, second] = (await decodeChunk(answer(0, payload), staticRecord)).frames;
  assert.deepEqual(first.audio, [3, 1]);
  assert.deepEqual(second.audio, [0, 2]);
  assert.deepEqual(first.dots[0], {
    id: 7, position: [10, 50], color: 1, type: "motorised", health: 49.999, max_health: 100, morale: 80,
    water_timer: 0, ship_timer: 12, in_city: false, healing: true, zrtyqz: "forest", path: [[20, 30]], ship: true,
  });
  assert.deepEqual(first.render.directions[0], { id: 7, facing: [1, 0], first_visual: [0.5, 0.5], visual: [0, 1], first_vibration: 0.25, second_vibration: -0.25 });
  assert.equal(second.dots[0].position[0], 11);
  assert.deepEqual(second.dots[0].path, [[20, 30]]);
  assert.deepEqual(second.render.contours, [[[[0.5, 1.25], [2, 3]]]]);
  assert.deepEqual(second.core.strength, [3, 4]);
  assert.deepEqual(second.core.cities, [{ position: [100, 200], color: 1 }, { position: [300, 400], color: 0 }]);
  assert.deepEqual(second.core.city_positions, staticRecord.static_core.city_positions);
  assert.deepEqual(second.core.dead_dots.map((d) => [d.frame, d.color, d.type, d.ship, d.position]), [
    [39, 0, "tank", false, [5, 6]],
    [40, 1, "infantry", true, [7, 8]],
  ]);
  // A chunk whose header promises more frames than it holds is refused.
  const short = bytes((w) => (w.u8(BINARY_FRAMES), w.u32(3), [40, 41, 42, 0, 0, 0, 0, 0, 0].forEach((v) => w.u32(v)), w.raw(body)));
  await assert.rejects(decodeChunk(answer(0, short), staticRecord));
});
