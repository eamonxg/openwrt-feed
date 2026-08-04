// POST /api/v1/me — the creator profile endpoint.
//
// Deliberately not REST-pure about conflicts: every authenticated,
// well-formed request answers 200 and reports trouble in the body. The only
// caller is the router's rpcd, which reaches the hub through
// wget/uclient-fetch -- those exit non-zero with empty output on any 4xx, so
// by the time a 409 reached the LuCI page it would be indistinguishable from
// "the hub is down". A malformed token still fails loudly: that is a bug in
// the caller, not an outcome a user can act on.

import { HttpError, deviceFromToken } from "./auth.js";
import { extractPalette } from "./configs.js";
import { jsonResponse, errorResponse, readJsonBounded } from "./http.js";

const SMALL_BODY_BYTES = 4096;

// No status filter: an author must be able to see that their own config was
// taken down, which the public browse endpoints deliberately hide.
async function listOwnConfigs(db, deviceId) {
  const { results } = await db
    .prepare(
      `SELECT id, name, downloads, assets_status, status, created_at, payload
         FROM configs
        WHERE device_id = ?
        ORDER BY created_at DESC, id ASC`
    )
    .bind(deviceId)
    .all();

  return results.map((row) => ({
    id: row.id,
    name: row.name,
    downloads: row.downloads,
    assets_status: row.assets_status,
    status: row.status,
    created_at: row.created_at,
    palette: extractPalette(JSON.parse(row.payload)),
  }));
}

async function me(request, env) {
  const body = await readJsonBounded(request, SMALL_BODY_BYTES);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_json", "Request body must be a JSON object.");
  }

  const device = await deviceFromToken(env.DB, body.device_token, { register: false });

  // An imported backup whose account never published looks exactly like this.
  // It is a legitimate state, not a failure.
  if (!device) {
    return jsonResponse({ id: null, nickname: null, configs: [] });
  }
  if (device.banned) {
    throw new HttpError(403, "device_banned", "This device has been banned.");
  }

  return jsonResponse({
    id: device.id,
    nickname: device.nickname ?? null,
    configs: await listOwnConfigs(env.DB, device.id),
  });
}

export async function handleMe(request, env) {
  try {
    return await me(request, env);
  } catch (err) {
    if (err instanceof HttpError) {
      return errorResponse(err.status, err.code, err.message);
    }
    console.error(err);
    return errorResponse(500, "internal_error", "Something went wrong.");
  }
}
