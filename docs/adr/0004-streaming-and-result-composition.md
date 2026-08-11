# ADR-0004: Streaming pagination and its composition with `Result`

Status: accepted
Date: 2026-08-11
Deciding ticket: [How streaming pagination composes with `Result`](../../.scratch/pd-cli-design/issues/12-grilling-streaming-and-result-composition.md)

## Context

`pd` returns errors as values through `neverthrow` rather than throwing, and a list command walks an
unbounded number of cursor pages. This ADR fixes the internal type of that walk and the control flow
that produces the output contract three earlier decisions already fixed:

- [ADR-0001](0001-error-model-and-exit-codes.md) — errors are a typed union carried on stdout, and
  every retryable failure is retried **inside the client module**, never by the caller.
- [ADR-0002](0002-output-format.md) — NDJSON, every line `type`-tagged, exactly one trailer, and the
  last line always carries `complete` and `emitted`. Records already written stay written.
- [ADR-0003](0003-pagination-bounding-and-partiality.md) — `--limit` counted in records and applied
  **after** zod rejection and deduplication; `skipped` and `duplicates` on every trailer; no
  resumption token.

Those decisions settle *what the bytes look like*. This ADR owns *what produces them*.

Several of the deciding ticket's questions were already answered by derivation and are recorded here
as constraints rather than re-argued:

- **stdout may hold a partial result, but never an incomplete document.** NDJSON has no document to
  truncate, so the question dissolves.
- **A validation failure is not a stream failure.** A zod-rejected record emits a `warning`,
  increments `skipped`, and the run continues. It can therefore never be the walk's `Err`.
- **A transport failure is terminal.** The trailer is exclusive and single and there is no
  resumption, so "continue and collect after an `Err`" has nothing it could do with the collection.
- **The walk never sees a retryable failure.** Backoff, the 429 inference and the Cloudflare stop all
  live beneath it in the one client module. By the time an `Err` reaches the page loop, retrying is
  already spent and the only correct response is to stop.

## Decision

### The walk is an async generator yielding `Result<Page, PdError>`

```ts
type Page = {
  records: Deal[]          // validated, deduplicated, and bounded
  warnings: Warning[]      // one per record zod rejected on this page
  duplicates: number       // records this page suppressed as already seen
  bound?: "limit"          // set on the final page only
}

async function* walkDeals(opts): AsyncGenerator<Result<Page, PdError>>
```

`ResultAsync<Deal[], PdError>` over the whole collection is **rejected as the primary type**. ADR-0002
measured 20 s of silence to first byte against 250 ms, with no memory saving, and removed the
"we can decide later" excuse: since a buffered NDJSON writer is byte-identical to a streaming one,
choosing the buffered type buys nothing and forecloses streaming inside it forever.

A generator that yields plain pages and returns the terminal `Result` in its *done* value was
considered and rejected. It makes "at most one error, and it ends the walk" structurally true, but at
the cost of the ordinary `for await` loop: the return value is silently discarded by `for await`, so
every call site would have to drive the iterator by hand. The invariant is instead protected by the
writer, below, which is where it can be checked at runtime rather than merely encoded.

### The generator owns validation, deduplication and the bound

`walkDeals` yields only clean, deduplicated, bounded pages. Nothing downstream re-filters.

This follows from ADR-0003 making `--limit` a count of *emitted* records: the decision to fetch
another page depends on how many records survived filtering, so the filter must sit where the fetch
loop can see it. Splitting them would need the count passed back upstream every page.

### `bound` rides on the page, so there is exactly one record count

The generator keeps **no running total of its own**. It compares against the limit using the count it
is about to yield, marks the final page with `bound: "limit"`, and stops. The writer's `emitted` is
the only cumulative record count in the process.

This is why the bound travels on the page value rather than in the generator's return position: the
return value is invisible to `for await`, and inferring the bound from `emitted === limit` in the
writer would report `complete: false` for a result set that happened to hold exactly `limit` records.

The generator must therefore resolve the same coincidence itself, and the rule is that the marker may
not lie:

| Situation | Trailer |
| --- | --- |
| The limit cut a page short, or the cursor continues | `bound: "limit"`, `complete: false` |
| The limit filled at a page boundary **and** the cursor is `null` | `finish(null)`, `complete: true` |
| The cursor continues but the next page would have been empty | `bound: "limit"`, `complete: false` |

The third row is a deliberate conservative error. With keyset-like cursors of undocumented stability
there is no way to know a following page is empty without fetching it, and reporting a walk as
complete when it might not be is the worse mistake.

### One writer object owns stdout, the counters and the single trailer

```ts
class NdjsonWriter {
  page(p: Page): void              // writes warnings then records; counts all three
  finish(bound: Bound | null): void
  error(e: PdError): void
}
```

- `NdjsonWriter` is the **only** thing in the process that writes to stdout.
- It holds `emitted`, `skipped` and `duplicates`, and it is the only thing that increments them. A
  counter cannot disagree with the decision that moved it.
- `finish` and `error` are the only ways to end a run, they write the one trailer, and the writer
  refuses a second call. A run that exits with no trailer written is a bug and surfaces as
  `internal` — checked on process exit, not left to review.

The consuming loop exists once:

```ts
for await (const r of walkDeals(opts)) {
  if (r.isErr()) return writer.error(r.error)
  writer.page(r.value)
  if (r.value.bound) return writer.finish(r.value.bound)
}
return writer.finish(null)
```

### A page is atomic

The generator yields either an `Ok` page or a terminal `Err`, never a partially materialised page.
A structural failure while parsing page seven produces `Err(invalid_response)`; the six pages already
written stay written and the run ends with the `error` trailer ADR-0002 specified. A caller therefore
never sees half of a page, only whole pages up to the failure.

### Single-resource commands use the same writer and emit a `summary`

`pd deal get 42` emits its `record` line and then
`{"type":"summary","complete":true,"emitted":1,"skipped":0,"duplicates":0}`.

The last-line invariant is total, so it holds for a command that fetches one record just as for one
that walks 40,000. Dropping `skipped` and `duplicates` for non-list commands was rejected: it makes
the trailer shape vary by command class, forcing a consumer to know which commands are lists before
it can read a trailer.

### The collected path exists, and is explicitly not the streaming path

A command needing whole-set post-processing — sorting, aggregation, "top 10 by value" — uses
`collect`, which drains the same generator into memory:

```ts
const all = await collect(walkDeals(opts))   // ResultAsync<Collected, PdError>
```

It reuses the same `NdjsonWriter`, so the output contract, the trailer and the counters are identical
and the format cannot diverge between the two paths. It costs time to first byte, and that cost is
the command's own: it asked for an answer that cannot be computed from a prefix.

**On failure the collected path emits `emitted: 0` and writes none of the records it holds.** Half of
a sorted list is not a partial answer, it is a wrong one — the records are in the wrong order, and
nothing in the output would tell the caller that. This deliberately diverges from the streaming
path's "already written stays written", because in the collected path no `record` line has been
written yet and the divergence costs the caller nothing it could have used.

`skipped` and `duplicates` are still reported truly on that error trailer: they were measured before
the failure, and `warning` lines are written as pages arrive rather than held back. **Consequence: in
the collected path, `warning` lines precede every `record` line.** ADR-0002 fixes the tag, not the
interleaving, and the trailer is still last.

## Consequences

- The exactly-one-trailer invariant is a runtime check in `NdjsonWriter`, not a type. A hand-rolled
  loop that forgets to call `finish` fails loudly rather than producing a stream with no trailer.
- `Page` is an internal type, not part of the output contract. Adding a field to it is not a breaking
  change; adding a field to a trailer is.
- Because the generator owns the `--limit` stop, the number of pages a bounded run fetches depends on
  how many records were rejected or deduplicated — as ADR-0003 already noted, and now with a named
  owner for the behaviour.
- `collect` is available but no command uses it yet. Any command that does must be recognised as a
  non-streaming command in the manifest, because its time to first byte is its total wall time.
- The walk sees only terminal errors, so the page loop has no retry, no backoff and no rate-limit
  logic in it at all. If any appears there, locked point 7 has been violated.
