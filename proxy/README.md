# Fetch relay

Google News answers a request from a Cloudflare Worker with HTTP 503 and its
"Sorry..." interstitial. The same URL returns 200 from a residential
connection. It is IP reputation, not headers: the default agent, a full Chrome
user-agent and a different Google News endpoint all get the same 503.

That is 39 of 97 sources, 28% of published items, and 39 Vermont outlets with
no other route into the feed, including the Barton Chronicle, The Commons,
Essex Reporter, Milton Independent, Waterbury Roundabout and Cabot Chronicle.

So the Worker relays only those fetches through home-server, and fetches
everything else directly. `src/egress.js` decides; it is inert unless
`FETCH_PROXY_URL` is set, so the Node CLI and the tests are unaffected.

## Two jobs

- `GET /?url=...` fetches an allowlisted URL and returns it, passing through
  `etag`, `last-modified` and `content-type` so the generator's conditional
  requests keep working, plus `x-final-url` so the caller sees where the
  request actually landed rather than the relay's own URL.
- `GET /decode?url=...` resolves a Google News article link to the publisher's
  URL. Those links are opaque base64 that only Google can resolve, and the
  decoder library makes two further calls to news.google.com with no way to
  redirect them. Running the decode here was worth more than the feeds alone:
  with it, a run went from 10.4 minutes to 2.5.

## What it is not

Not a general proxy. It only accepts `GET`, only `http`/`https`, only hosts on
`ALLOW_HOSTS`, and only with the bearer token. The allowlist is what stops it
becoming a route into the home network.

## Deploy on home-server

Docker first, per the exposure policy in `ames-local-automation:home-server-ops`.

```bash
ssh home-server 'mkdir -p ~/docker/cerulean-fetch-relay'
scp proxy/server.mjs proxy/Dockerfile proxy/docker-compose.yml \
  home-server:~/docker/cerulean-fetch-relay/
```

Generate the shared token once and write it to the compose env file:

```bash
ssh home-server 'cd ~/docker/cerulean-fetch-relay \
  && umask 077 \
  && printf "PROXY_TOKEN=%s\n" "$(openssl rand -hex 32)" > .env \
  && /usr/local/bin/docker compose up -d --build \
  && sleep 3 && curl -fsS http://127.0.0.1:8790/health'
```

Note `docker` is not on the default SSH PATH; use `/usr/local/bin/docker`. If
the build fails on the credential helper, that is the known Keychain-over-SSH
problem documented in the home-server skill.

## Expose it through the amesvt tunnel

Ingress for the `amesvt` tunnel is dashboard-managed, so `~/.cloudflared/config.yml`
on the host is decorative. Add a hostname (suggested `fetch.amesvt.com`)
pointing at `http://127.0.0.1:8790`, via the dashboard or the API using the
1Password item "Cloudflare Global API Key" with `X-Auth-Email: oliverames@gmail.com`.

Verify from off-network:

```bash
curl -sI https://fetch.amesvt.com/health | head -3
```

## Point the Worker at it

```bash
cd ~/Developer/Projects/cerulean-news
npx wrangler@4 secret put FETCH_PROXY_URL    # https://fetch.amesvt.com/
npx wrangler@4 secret put FETCH_PROXY_TOKEN  # the value from .env
```

`FETCH_PROXY_HOSTS` defaults to `news.google.com`; set it only to widen the
allowlist, and widen the relay's `ALLOW_HOSTS` to match.

## Check it worked

After the next run, the Google News sources should report `ok`:

```bash
curl -s https://cerulean-news.oliverames.workers.dev/feed-audit.json \
  | jq '[.sources[] | select(.ok != true)] | length'
```

That count was 38 with the relay absent and should fall to roughly 2 with it
in place (MyNBC5 returns 451 independently).

## If home-server is down

The relay failing is not fatal. Those sources fail, alert through the existing
webhooks, and their items stay in the archive until they age out. The rest of
the feed keeps publishing. The Worker does not depend on home-server for
anything else.
