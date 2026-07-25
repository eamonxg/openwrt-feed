# openwrt-feed

The signed OpenWrt package feed behind `packages.json`, together with the
landing page in `site/`. CI builds each listed package in both `opkg` and `apk`
form, publishes them under `releases/` and `snapshots/`, and deploys the feed
and the page to Cloudflare.

## Third-party assets

Files in `site/assets` that come from elsewhere, and the terms they arrive
under. The two fonts are distributed under the SIL Open Font License 1.1; this
notice is where their required copyright and licence notice travels.

| File | Source | License |
| --- | --- | --- |
| `geist-mono-variable.woff2` | [vercel/geist-font](https://github.com/vercel/geist-font) (npm `geist@1.3.1`) | SIL OFL 1.1 |
| `shantell-sans-500.woff2` | [Shantell Sans](https://github.com/arrowtype/shantell-sans) (npm `@fontsource/shantell-sans@5.2.5`, latin 500) | SIL OFL 1.1 |
| `neat-annotations.css` | [syabro/neat-annotations](https://github.com/syabro/neat-annotations) | MIT (original notice kept in the file header) |
| `ambience-blinds.m4a` | ["200714 Early Summer morning birds, Robins House Window" by TRP, freesound.org](https://freesound.org/s/567912/) (100 s excerpt, level-matched, re-encoded AAC mono 64k) | CC0 |
| `ambience-leaves.m4a` | ["AMBTrop_Novo Airão, Amazonas, Brasil" by quehablas, freesound.org](https://freesound.org/s/826495/) (100 s excerpt, level-matched, re-encoded AAC mono 64k) | CC0 |
