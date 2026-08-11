/**
 * Throwaway prototype for ticket 10 — what does buffering a whole JSON array cost?
 *
 * Measures peak heap and time-to-first-byte for a 40,000-deal result set rendered
 * as (a) one buffered JSON envelope and (b) streamed NDJSON. Writes to /dev/null
 * so the numbers are the tool's cost, not the terminal's.
 *
 * Run: bun run .scratch/pd-cli-design/prototypes/10-output-format/bench.ts
 */

import { openSync, writeSync, closeSync } from "node:fs";

const N = Number(process.env.N ?? 40_000);
const PAGE = 500; // Pipedrive v2 max page size
const PAGE_LATENCY_MS = Number(process.env.PAGE_LATENCY_MS ?? 0);

const HASH_AMOUNT = "8a1b3c9d2e4f5061728394a5b6c7d8e9f0a1b2c3";
const HASH_SOURCE = "1f2e3d4c5b6a798877665544332211aabbccddee";

const deal = (i: number) => ({
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
  custom_fields: { [HASH_AMOUNT]: 4200, [HASH_SOURCE]: 34 },
});

const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

async function benchArray() {
  const fd = openSync("/dev/null", "w");
  Bun.gc(true);
  const baseline = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  // Every page must be retained: the envelope cannot be written until the run
  // ends, because a failure on the last page changes the document.
  const all: unknown[] = [];
  let peakRss = 0;
  for (let offset = 0; offset < N; offset += PAGE) {
    await sleep(PAGE_LATENCY_MS);
    for (let i = offset; i < Math.min(offset + PAGE, N); i++) all.push(deal(i));
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  // Forced GC first: what survives is genuinely retained, not garbage awaiting collection.
  Bun.gc(true);
  const retained = process.memoryUsage().heapUsed;

  const body = JSON.stringify({
    type: "result",
    command: "deals list",
    data: all,
    complete: true,
    emitted: all.length,
  });
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const ttfb = performance.now() - t0;
  writeSync(fd, body);
  const total = performance.now() - t0;
  closeSync(fd);

  return {
    format: "json array (envelope, buffered)",
    ttfb_ms: ttfb.toFixed(0),
    total_ms: total.toFixed(0),
    bytes: body.length,
    retained_mb: mb(retained - baseline),
    peak_rss_mb: mb(peakRss),
  };
}

async function benchNdjson() {
  const fd = openSync("/dev/null", "w");
  Bun.gc(true);
  const baseline = process.memoryUsage().heapUsed;
  const t0 = performance.now();

  let ttfb = 0;
  let bytes = 0;
  let peakRss = 0;

  // Only one page is live at a time; each is serialised and released.
  for (let offset = 0; offset < N; offset += PAGE) {
    await sleep(PAGE_LATENCY_MS);
    const page: unknown[] = [];
    for (let i = offset; i < Math.min(offset + PAGE, N); i++) page.push(deal(i));
    const chunk =
      page.map((d) => JSON.stringify({ type: "record", data: d })).join("\n") +
      "\n";
    if (ttfb === 0) ttfb = performance.now() - t0;
    writeSync(fd, chunk);
    bytes += chunk.length;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }
  Bun.gc(true);
  const retained = process.memoryUsage().heapUsed;

  const summary =
    JSON.stringify({ type: "summary", complete: true, emitted: N }) + "\n";
  writeSync(fd, summary);
  bytes += summary.length;
  const total = performance.now() - t0;
  closeSync(fd);

  return {
    format: "ndjson (streamed)",
    ttfb_ms: ttfb.toFixed(0),
    total_ms: total.toFixed(0),
    bytes,
    retained_mb: mb(retained - baseline),
    peak_rss_mb: mb(peakRss),
  };
}

// Bun's heapUsed is too noisy to compare the two formats directly, so retention
// is measured on its own, in stages, against RSS after a forced GC.
function benchRetention() {
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  const all = Array.from({ length: N }, (_, i) => deal(i));
  Bun.gc(true);
  const withRecords = process.memoryUsage().rss;
  const body = JSON.stringify({ data: all });
  Bun.gc(true);
  const withString = process.memoryUsage().rss;
  return {
    base,
    records: withRecords - base,
    serialising: withString - withRecords,
    jsonBytes: body.length,
    peak: withString,
  };
}

const retention = benchRetention();
console.log(
  `buffering ${N} records: +${mb(retention.records)} MB of parsed objects, ` +
    `+${mb(retention.serialising)} MB more to serialise a ${mb(retention.jsonBytes)} MB document, ` +
    `peak ${mb(retention.peak)} MB RSS (baseline ${mb(retention.base)} MB)\n`,
);
Bun.gc(true);

const arrayResult = await benchArray();
Bun.gc(true);
const ndjsonResult = await benchNdjson();
const results = [arrayResult, ndjsonResult] as Array<Record<string, unknown>>;

console.log(
  `N=${N} records, page size ${PAGE}, simulated page latency ${PAGE_LATENCY_MS}ms\n`,
);
for (const r of results) {
  console.log(r.format);
  console.log(`  time to first byte : ${r.ttfb_ms} ms`);
  console.log(`  total wall time    : ${r.total_ms} ms`);
  console.log(`  bytes on stdout    : ${mb(Number(r.bytes))} MB`);

  console.log(`  peak RSS           : ${r.peak_rss_mb} MB\n`);
}
