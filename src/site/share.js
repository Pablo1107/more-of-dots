// Replays a visitor chooses to share go to the wod-replays worker (share/), which
// keeps them under the same id as the library does, so a link opens them anywhere.
const API = import.meta.env.VITE_SHARE_API ?? "https://wod-replays.moreofdots.workers.dev";

async function request(path, options) {
  let response;
  try {
    response = await fetch(`${API}/replays${path}`, options);
  } catch {
    throw new Error("Could not reach the replay service.");
  }
  if (!response.ok) {
    const { error } = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error ?? "The replay service is not available right now."), { status: response.status });
  }
  return response;
}

/// Uploads a replay. Resolves to `{ id, token }`; `token` lets this browser stop
/// sharing it and is missing when someone had already shared the same file.
export const shareReplay = async (blob) => (await request("", { method: "POST", body: blob })).json();

/// A shared replay's file, or null when it is no longer shared.
export async function fetchShared(id) {
  try {
    return await (await request(`/${id}`)).blob();
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function unshareReplay(id, token) {
  try {
    await request(`/${id}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}
