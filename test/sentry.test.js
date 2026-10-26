import test from "node:test";
import assert from "node:assert/strict";
import { beforeSend, sentryOptions } from "../worker/sentry.js";

test("sentry is off without a DSN, collects nothing, and tags the Worker", () => {
  const options = sentryOptions("cerulean-news-mail")({});
  assert.equal(options.dsn, undefined);
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.environment, "production");
  assert.deepEqual(options.initialScope, { tags: { worker: "cerulean-news-mail" } });
  const { userInfo, cookies, httpHeaders, urlQueryParams, httpBodies } = options.dataCollection;
  assert.deepEqual([userInfo, cookies, httpHeaders, urlQueryParams, httpBodies], [false, false, false, false, []]);
  assert.equal(options.beforeBreadcrumb(), null);
});

test("beforeSend keeps only the request method and path and scrubs messages", () => {
  const token = "eyJ" + "a".repeat(60) + ".sig";
  const event = beforeSend({
    request: { method: "POST", url: `https://cerulean.news/api/mail/confirm?token=${token}`, data: "email=reader%40example.com", headers: { Cookie: `team=${token}` }, cookies: { team: token }, query_string: `token=${token}` },
    user: { ip_address: "203.0.113.9", email: "reader@example.com" },
    breadcrumbs: [{ category: "console", message: '{"to":"r***@example.com"}' }],
    contexts: { culture: { timezone: "America/New_York" }, runtime: { name: "cloudflare" } },
    exception: { values: [{ type: "Error", value: `send to reader@example.com failed with ${token} at https://cerulean.news/api/mail/unsubscribe?token=${token}`, stacktrace: { frames: [{ filename: "/Users/someone/cerulean-news/.wrangler/tmp/worker.js", abs_path: "/Users/someone/cerulean-news/.wrangler/tmp/worker.js" }] } }] },
  });
  assert.deepEqual(event.request, { method: "POST", url: "https://cerulean.news/api/mail/confirm" });
  assert.equal(event.user, undefined);
  assert.deepEqual(event.contexts, { runtime: { name: "cloudflare" } });
  assert.equal(event.exception.values[0].value, "send to [email] failed with [token] at https://cerulean.news/api/mail/unsubscribe");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "worker.js");
  assert.doesNotMatch(JSON.stringify(event), /example\.com|eyJ|203\.0\.113|someone/);
});
