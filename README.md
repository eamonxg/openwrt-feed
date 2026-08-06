# openwrt-cloud

The online services behind the eamonxg OpenWrt/LuCI ecosystem. Each
top-level directory is an independently deployed Cloudflare Worker:

| Directory | Serves | What it is |
| --- | --- | --- |
| `feed/` | `openwrt.<DOMAIN>` | The signed OpenWrt package feed behind `feed/packages.json`, together with its landing page in `feed/site/`. CI builds each listed package in both `opkg` and `apk` form, publishes them under `releases/` and `snapshots/`, and deploys the feed and the page to Cloudflare. |
| `hub/` | `themes.<DOMAIN>` | (planned) The themes hub: a gallery and API for sharing LuCI theme configurations. |

The real domain is never committed; workflows substitute it from repo
variables (`FEED_HOST`, `HUB_HOST`).

## `hub/` Worker secrets

None of these are injected by CI — set them once per environment with
`npx wrangler secret put <NAME> --config hub/wrangler.jsonc` (render the
config first with `hub/scripts/render-config.sh`).

| Secret | Without it |
| --- | --- |
| `ADMIN_TOKEN` | `/admin` and every `/api/v1/admin/*` route answers 500 `admin_disabled`. Fails closed on purpose: an empty expected value must never compare equal to an empty Bearer token. |
| `ADMIN_TOKENS` | Optional — without it, `ADMIN_TOKEN` is the only identity and every `admin_actions` row is attributed to `root`. Format is comma-separated `name:token` pairs (e.g. `alice:<hex>,bob:<hex>`); each name becomes the actor recorded in `admin_actions`. A name must match `[A-Za-z0-9_-]{1,32}`, and a malformed entry is skipped (with a `console.warn`) rather than rejecting the whole secret. |
| `TICKET_SECRET` | Browser-direct asset upload answers 500 `upload_disabled`. The single-request publish endpoint (`POST /api/v1/themes/:theme/configs`) keeps working, so an unset secret degrades rather than breaks. |

Generate `TICKET_SECRET` with `head -c32 /dev/urandom | xxd -p -c64`. Rotating
it invalidates outstanding upload tickets; they live 30 minutes, so a rotation
can at worst make someone's in-flight publish fail and need retrying.

## `hub/` R2 lifecycle

The `themes-hub-assets` bucket needs one rule: **delete objects under the
`draft/` prefix after 1 day**. Browser-direct uploads land there before their
config exists, and an abandoned publish leaves those bytes behind — this rule
is the only thing that reclaims them, there is no application-level GC.

Dashboard: *R2 → themes-hub-assets → Settings → Object lifecycle rules → Add
rule*, prefix `draft/`, delete after 1 day.

Abandoned `drafts` rows are a few hundred bytes each and are left to
accumulate; no Cron Trigger is worth the operational surface. Clear them by
hand if they ever matter:

```sql
DELETE FROM drafts WHERE created_at < datetime('now', '-1 day');
```

## Third-party assets

Files in `feed/site/assets` that come from elsewhere, and the terms they
arrive under. The two fonts are distributed under the SIL Open Font License
1.1; this notice is where their required copyright and licence notice
travels.

| File | Source | License |
| --- | --- | --- |
| `geist-mono-variable.woff2` | [vercel/geist-font](https://github.com/vercel/geist-font) (npm `geist@1.3.1`) | SIL OFL 1.1 |
| `shantell-sans-500.woff2` | [Shantell Sans](https://github.com/arrowtype/shantell-sans) (npm `@fontsource/shantell-sans@5.2.5`, latin 500) | SIL OFL 1.1 |
| `neat-annotations.css` | [syabro/neat-annotations](https://github.com/syabro/neat-annotations) | MIT (original notice kept in the file header) |
| `ambience-blinds.m4a` | ["200714 Early Summer morning birds, Robins House Window" by TRP, freesound.org](https://freesound.org/s/567912/) (100 s excerpt, level-matched, re-encoded AAC mono 64k) | CC0 |
| `ambience-leaves.m4a` | ["AMBTrop_Novo Airão, Amazonas, Brasil" by quehablas, freesound.org](https://freesound.org/s/826495/) (100 s excerpt, level-matched, re-encoded AAC mono 64k) | CC0 |
