# Cloudflare Migration History

The [July 21, 2026 migration plan](docs/history/2026-07-21%20Cloudflare%20Migration%20Plan.md) is preserved verbatim. It records the earlier hosting proposal, alternatives and research; its dual-hosting recommendation is historical.

As of October 13, 2026, the [publish workflow](.github/workflows/publish-feed.yml) uses the Node generator and uploads `site/` to the `bluenews` Cloudflare Pages project, with `https://cerulean.news` as the configured public URL. The [README](README.md) describes the current reader and publishing path.

The alternate Worker and relay remain in the repository. Use the [runtime overview](README.md#alternate-worker-runtime), [relay instructions](proxy/README.md) and [Worker configuration](wrangler.toml) when reviewing that path. The archived plan retains its design rationale, but does not establish a currently running Worker or relay.
