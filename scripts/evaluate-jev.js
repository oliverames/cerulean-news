import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadAlignmentProfile } from "../src/jev-alignment.js";
import { loadReferenceExamples } from "../src/jev-examples.js";
import { evaluateArchive } from "../src/jev-benchmark.js";

const { values } = parseArgs({ options: {
  snapshot: { type: "string" }, holdout: { type: "string" }, output: { type: "string" },
  alignment: { type: "string" },
  concurrency: { type: "string", default: "4" }, limit: { type: "string" },
} });
if (!values.snapshot || !values.output) {
  console.error("Usage: node scripts/evaluate-jev.js --snapshot FILE [--holdout PRIVATE_FILE] --output PRIVATE_DIRECTORY [--alignment PROFILE_FILE] [--concurrency 4] [--limit N]");
  process.exitCode = 1;
} else {
  const snapshot = JSON.parse(await readFile(values.snapshot, "utf8"));
  const holdout = values.holdout ? JSON.parse(await readFile(values.holdout, "utf8")) : { rows: [] };
  const alignment = values.alignment ? await loadAlignmentProfile(values.alignment) : undefined;
  const reference = alignment ? await loadReferenceExamples(snapshot.items, { config: alignment.references }) : undefined;
  if (alignment && reference.status !== "loaded") throw new Error(`Human examples are ${reference.status}`);
  const limit = values.limit ? Number(values.limit) : Infinity;
  if (!(limit > 0)) throw new Error("Limit must be positive");
  const report = await evaluateArchive({ snapshot, holdout, alignment, referenceExamples: reference?.examples, outputDirectory: values.output,
    concurrency: Number(values.concurrency), limit,
    onProgress: (progress) => console.log(JSON.stringify(progress)) });
  console.log(JSON.stringify(report.summary, null, 2));
  if (report.summary.failed) process.exitCode = 1;
}
