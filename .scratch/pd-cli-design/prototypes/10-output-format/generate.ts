/**
 * Throwaway prototype for ticket 10 — output format for large paginated results.
 *
 * Generates the same realistic result set rendered as (a) a JSON envelope around
 * an array and (b) NDJSON, across five cases: complete, empty, bounded-partial,
 * mid-stream failure, and a record that failed validation.
 *
 * Run: bun run .scratch/pd-cli-design/prototypes/10-output-format/generate.ts
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(import.meta.dir, "samples");
mkdirSync(OUT, { recursive: true });

// A deal as Pipedrive v2 actually returns it: custom fields are 40-char hashes,
// no total count anywhere, timestamps are ISO-8601 strings.
type Deal = Record<string, unknown>;

const HASH_AMOUNT = "8a1b3c9d2e4f5061728394a5b6c7d8e9f0a1b2c3";
const HASH_SOURCE = "1f2e3d4c5b6a798877665544332211aabbccddee";

const deal = (i: number): Deal => ({
  id: 1000 + i,
  title: `Acme Oy — annual licence ${2020 + (i % 6)}`,
  value: 12000 + i * 37,
  currency: "EUR",
  status: ["open", "won", "lost"][i % 3],
  stage_id: 3 + (i % 4),
  pipeline_id: 1,
  person_id: 5000 + i,
  org_id: 900 + (i % 40),
  owner_id: 11,
  add_time: "2025-11-03T09:14:22Z",
  update_time: "2026-02-18T13:01:07Z",
  custom_fields: {
    [HASH_AMOUNT]: 4200,
    [HASH_SOURCE]: 34,
  },
});

const deals = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => deal(from + i));

const write = (name: string, body: string) =>
  writeFileSync(join(OUT, name), body.endsWith("\n") ? body : body + "\n");

const json = (v: unknown) => JSON.stringify(v, null, 2);
const line = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// Case A — complete success, 4 records
// ---------------------------------------------------------------------------

const complete = deals(4);

write(
  "a-complete.array.json",
  json({
    type: "result",
    command: "deals list",
    data: complete,
    complete: true,
    emitted: complete.length,
  }),
);

write(
  "a-complete.ndjson",
  [
    ...complete.map((d) => line({ type: "record", data: d })),
    line({ type: "summary", complete: true, emitted: complete.length }),
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// Case B — empty result. An empty success, not not_found.
// ---------------------------------------------------------------------------

write(
  "b-empty.array.json",
  json({
    type: "result",
    command: "deals list",
    data: [],
    complete: true,
    emitted: 0,
  }),
);

write(
  "b-empty.ndjson",
  line({ type: "summary", complete: true, emitted: 0 }),
);

// ---------------------------------------------------------------------------
// Case C — guard hit: --max-requests reached. Exit 3, request_ceiling.
// Partial data IS present alongside the error.
// ---------------------------------------------------------------------------

const partial = deals(3);
const ceilingError = {
  code: "request_ceiling",
  message: "Stopped after 50 requests; raise --max-requests to continue.",
  complete: false,
  emitted: partial.length,
  exit_code: 3,
  retry: "never",
  details: {},
};

write(
  "c-guard-request-ceiling.array.json",
  json({
    type: "result",
    command: "deals list",
    data: partial,
    complete: false,
    emitted: partial.length,
    error: ceilingError,
  }),
);

write(
  "c-guard-request-ceiling.ndjson",
  // One trailer, exclusive: an error line replaces the summary and carries the
  // completeness marker itself. Nothing is duplicated across two lines.
  [
    ...partial.map((d) => line({ type: "record", data: d })),
    line({ type: "error", ...ceilingError }),
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// Case D — mid-stream failure. Bytes already on stdout, then page 7 dies.
// This is the case that decides the format.
// ---------------------------------------------------------------------------

const beforeFailure = deals(5);
const midStreamError = {
  code: "rate_limited",
  message: "Burst limit exceeded and retries were exhausted.",
  complete: false,
  emitted: beforeFailure.length,
  exit_code: 3,
  retry: "after",
  retry_after_seconds: 4,
  details: { http_status: 429, path: "/api/v2/deals" },
};

// Envelope variant: nothing may be written until the outcome is known, so the
// whole run buffers. Compare the time-to-first-byte numbers from bench.ts.
write(
  "d-midstream-failure.array.json",
  json({
    type: "result",
    command: "deals list",
    data: beforeFailure,
    complete: false,
    emitted: beforeFailure.length,
    error: midStreamError,
  }),
);

write(
  "d-midstream-failure.ndjson",
  [
    ...beforeFailure.map((d) => line({ type: "record", data: d })),
    line({ type: "error", ...midStreamError }),
  ].join("\n"),
);

// What a naive consumer sees if the envelope is streamed rather than buffered:
// a truncated document that no JSON parser accepts.
write(
  "d-midstream-failure.truncated-array.json",
  json({ type: "result", command: "deals list", data: beforeFailure })
    .replace(/\n\s*\]\n\}$/, "\n") + "  ... process died here, no closing bracket",
);

// ---------------------------------------------------------------------------
// Case E — one record failed zod validation. The run continues.
// ---------------------------------------------------------------------------

const good = deals(2);
const afterBad = deals(1, 3);
const warning = {
  type: "warning",
  code: "invalid_record",
  message: "Deal 1002 rejected by schema; skipped.",
  details: { id: 1002, issue: "value: expected number, received string" },
};

write(
  "e-validation-warning.array.json",
  json({
    type: "result",
    command: "deals list",
    data: [...good, ...afterBad],
    complete: true,
    emitted: 3,
    warnings: [warning],
  }),
);

write(
  "e-validation-warning.ndjson",
  [
    ...good.map((d) => line({ type: "record", data: d })),
    line(warning),
    ...afterBad.map((d) => line({ type: "record", data: d })),
    line({ type: "summary", complete: true, emitted: 3, warnings: 1 }),
  ].join("\n"),
);

// ---------------------------------------------------------------------------
// Case F — usage error. No list was ever started, so there is no summary line:
// the single error line is the whole output, and carries the invariant fields.
// ---------------------------------------------------------------------------

write(
  "f-usage-error.ndjson",
  line({
    type: "error",
    code: "usage",
    message: "Unknown flag --frobnicate.",
    complete: false,
    emitted: 0,
    exit_code: 2,
    retry: "never",
    details: {},
  }),
);

console.error(`wrote samples to ${OUT}`);
