// Reading .rep files: gzip or plain JSON. Replays are checked and described
// without JSON.parse, which would cost too much time on a large one.
export const MAX_SIZE = 1 << 20;
const MAX_TEXT = 32 << 20;

/// The replay's text, or null when it is not gzip or text or is too large.
export async function replayText(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
  const decoder = new TextDecoder();
  let text = "";
  try {
    for await (const chunk of new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > MAX_TEXT) return null;
    }
  } catch {
    return null;
  }
  return text;
}

/// Whether the text is a War of Dots replay: JSON with a map, as the site reads them.
export function isReplay(text) {
  const trimmed = text?.trim() ?? "";
  return trimmed.startsWith("{") && trimmed.endsWith("}") && (trimmed.includes('"map"') || trimmed.includes('"custom_map"'));
}

/// The JSON array that starts at `from`, skipping brackets inside strings.
function arrayAt(text, from) {
  const start = text.indexOf("[", from);
  if (start < 0) return null;
  for (let i = start, depth = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
    } else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/// The players (one name per side, teammates joined with " & "), length in frames
/// and game version a replay records.
export function details(text) {
  const key = ['"player_usernames"', '"player_names"'].map((k) => text.indexOf(k)).find((at) => at >= 0);
  let players = [];
  if (key !== undefined) {
    try {
      players = JSON.parse(arrayAt(text, key) ?? "[]").map((team) =>
        (Array.isArray(team) ? team : [team]).map((p) => (typeof p === "string" ? p : p?.username ?? "")).join(" & "));
    } catch {
      players = [];
    }
  }
  // Moves and the map carry their own keys, so the last top-level match is the replay's.
  const last = (pattern) => [...text.matchAll(pattern)].at(-1)?.[1] ?? null;
  const end = last(/"end"\s*:\s*(\d+)/g);
  return { players, frames: end === null ? null : Number(end), version: last(/"version"\s*:\s*"([^"]{1,32})"/g) };
}
