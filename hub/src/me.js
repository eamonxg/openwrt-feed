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
import { extractPreview, previewAssets } from "./configs.js";
import { validateNickname } from "./validate.js";
import { jsonResponse, errorResponse, readJsonBounded } from "./http.js";

const SMALL_BODY_BYTES = 4096;

// Two kinds of row reach the author, and exactly two: what is live, and what
// an admin took down. What the author deleted themselves is NOT here.
//
// This used to be an unfiltered `WHERE device_id = ?`, defended as "an author
// must be able to see that their own config was taken down". The intent was
// right, the query was not: it also returned the rows the author had just
// deleted, and there was no column that told the two apart -- so the client
// had no choice but to hide every removed row, which threw the takedowns out
// with them. removed_by (migration 0007) is what makes the intended filter
// expressible at all.
//
// A takedown the admin later purged stays visible too: the bytes are gone,
// but "your config was taken down" is still the truthful answer, and it is
// the only place the author will ever be told.
async function listOwnConfigs(db, deviceId) {
  const { results } = await db
    .prepare(
      // rowid, not id, breaks the created_at tie: datetime('now') only has
      // second resolution, so two configs published in the same second are
      // indistinguishable by timestamp, and configs.id is a random shortId --
      // ordering by it would scramble "newest first" at random. rowid is
      // monotonic in insertion order, which is exactly the intent.
      //
      // The assets LEFT JOIN mirrors the browse list's: `preview.assets` must
      // mean the same thing on both endpoints -- approved bytes only, never
      // what is still pending or already rejected -- or the author's own copy
      // of a card would promise artwork the store does not serve.
      `SELECT c.id, c.name, c.downloads, c.assets_status, c.status,
              c.created_at, c.payload,
              GROUP_CONCAT(a.kind) AS approved_kinds
         FROM configs c
         LEFT JOIN assets a ON a.config_id = c.id AND a.status = 'approved'
        WHERE c.device_id = ?
          AND (c.status = 'active' OR c.removed_by = 'admin')
        GROUP BY c.id
        ORDER BY c.created_at DESC, c.rowid DESC`
    )
    .bind(deviceId)
    .all();

  return results.map((row) => ({
    id: row.id,
    name: row.name,
    downloads: row.downloads,
    assets_status: row.assets_status,
    // 'active' or 'removed'. After the filter above, 'removed' can only mean
    // an admin takedown -- the client renders it as such without needing to
    // know why.
    status: row.status,
    created_at: row.created_at,
    preview: extractPreview(JSON.parse(row.payload), previewAssets(row.id, row.approved_kinds)),
  }));
}

async function me(request, env) {
  const body = await readJsonBounded(request, SMALL_BODY_BYTES);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "bad_json", "Request body must be a JSON object.");
  }

  // Registration only happens on a write: a plain profile read must never
  // create a devices row, or every reflashed router would litter the table.
  const wantsRename = body.nickname !== undefined;
  const device = await deviceFromToken(env.DB, body.device_token, { register: wantsRename });

  // An imported backup whose account never published looks exactly like this.
  // It is a legitimate state, not a failure.
  if (!device) {
    return jsonResponse({ id: null, nickname: null, configs: [] });
  }
  if (device.banned) {
    throw new HttpError(403, "device_banned", "This device has been banned.");
  }

  let profile = device;

  if (wantsRename) {
    let normalized;
    try {
      normalized = validateNickname(body.nickname);
    } catch {
      // Reported in-body for the same reason as nickname_taken; see the file
      // header. The client already length-checks, so this is the belt.
      return jsonResponse({
        id: device.id,
        nickname: device.nickname ?? null,
        configs: [],
        error: "invalid_nickname",
      });
    }

    // Re-asserting the name you already hold is a no-op, not a conflict.
    if (normalized.nickname_lc !== device.nickname_lc) {
      const conflict = {
        id: device.id,
        nickname: device.nickname ?? null,
        configs: [],
        error: "nickname_taken",
      };

      const taken = await env.DB.prepare("SELECT id FROM devices WHERE nickname_lc = ?")
        .bind(normalized.nickname_lc)
        .first();
      if (taken) return jsonResponse(conflict);

      try {
        await env.DB.prepare("UPDATE devices SET nickname = ?, nickname_lc = ? WHERE id = ?")
          .bind(normalized.nickname, normalized.nickname_lc, device.id)
          .run();
      } catch {
        // Race: another device claimed it between the SELECT and the UPDATE.
        // idx_devices_nick is the actual arbiter; the SELECT is only a
        // cheaper first pass.
        return jsonResponse(conflict);
      }

      profile = { ...device, nickname: normalized.nickname, nickname_lc: normalized.nickname_lc };
    }
  }

  return jsonResponse({
    id: profile.id,
    nickname: profile.nickname ?? null,
    configs: await listOwnConfigs(env.DB, profile.id),
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
