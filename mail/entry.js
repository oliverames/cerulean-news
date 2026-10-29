// Worker entry.
//
// workerd treats every named export of the entry module as an entrypoint, and
// `worker.js` exports its constants and helpers so the tests can import them.
// A string like `CRON_ALERTS` is not a function or an ExportedHandler, so
// `wrangler dev` refused to start the Worker with
//
//   Incorrect type for map entry 'CRON_ALERTS'
//
// This module is the only entry: it exports the default handler and nothing
// else, while the tests keep importing the same `worker.js` they always have.
import worker from "./worker.js";

export default worker;
