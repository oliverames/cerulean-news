// Sentry error reporting for both Workers in this repository: the parked
// feed Worker (worker/index.js) and the mail Worker (mail/worker.js). They
// report to the same Sentry project, and each event carries a `worker` tag
// naming the Worker it came from.
//
// Inert until the SENTRY_DSN secret is set, so tests, forks and local runs
// without .dev.vars send nothing. The mail Worker holds subscriber and team
// email addresses, signed link tokens and session cookies, so an event carries
// only the error, its stack, and the request method and path. The SDK's own
// data collection is off (SDK 11 dropped sendDefaultPii, and its replacement
// collects by default), and beforeSend drops the request body, headers,
// cookies, query string, user, IP address, timezone and breadcrumbs, and cuts
// long tokens, query strings and email addresses out of error messages.

const URL_TAIL = /(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TOKEN = /[A-Za-z0-9_.-]{32,}/g;

export function scrubText(text) {
  return text.replace(URL_TAIL, "$1").replace(EMAIL, "[email]").replace(TOKEN, "[token]");
}

const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

export function beforeSend(event) {
  if (event.request) {
    let url;
    try {
      const parsed = new URL(event.request.url);
      url = parsed.origin + parsed.pathname;
    } catch {
      url = undefined;
    }
    event.request = { method: event.request.method, url };
  }
  delete event.user;
  delete event.breadcrumbs;
  delete event.extra;
  if (event.contexts) delete event.contexts.culture;
  if (event.message) event.message = scrubText(event.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value);
    // Under wrangler dev the bundle sits in the checkout, so frames carry a local path.
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename) frame.filename = baseName(frame.filename);
      if (frame.abs_path) frame.abs_path = baseName(frame.abs_path);
    }
  }
  return event;
}

export const dataCollection = Object.freeze({
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [],
  urlQueryParams: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
});

// `worker` is the Worker's name, reported as a tag on every event.
export function sentryOptions(worker) {
  return (env) => ({
    dsn: env.SENTRY_DSN || undefined,
    environment: env.SENTRY_ENVIRONMENT || "production",
    tracesSampleRate: 0,
    dataCollection,
    initialScope: { tags: { worker } },
    beforeSend,
    // Console breadcrumbs carry log lines with masked addresses and source
    // URLs; fetch breadcrumbs carry outlet URLs. Keep none.
    beforeBreadcrumb: () => null,
  });
}
