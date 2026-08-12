# Related-entity expansion: pulling the whole related record

Type: grilling
Status: open

Blocked by: 15, 16, 17

## Question

`--resolve` already answers "who is person 901" with a name
([ADR-0008](../../../docs/adr/0008-resolution-mechanics.md)). Can a caller instead pull the **whole**
related record — the person's email, the organisation's address — in one command, and what does that do
to the output contract?

- **Is it a distinct flag or an extension of `--resolve`?** ADR-0008 made `--resolve` one additive flag
  covering hashes, option labels, owner ids and six relation kinds, all landing in a parallel
  `custom_fields_resolved` block keyed by hash. A whole record is a different shape — it is not a label
  — so it needs somewhere else to live, or a reason to live there anyway.
- **Where does an expanded record go in NDJSON?** [ADR-0002](../../../docs/adr/0002-output-format.md)
  makes every line `type`-tagged with exactly one trailer. Options: nested inside the `record` line, a
  separate `type` the consumer joins by id, or a second NDJSON stream. Nesting bloats every record and
  duplicates the same organisation hundreds of times; a join-by-id line is smaller but makes the
  consumer do work.
- **Which ceiling bounds it?** [ADR-0011](../../../docs/adr/0011-concurrency-and-retry.md) settled the
  gate and [ADR-0010](../../../docs/adr/0010-budget-guard.md) §4 settled the rule that enrichment yields
  to `--max-requests` and never trips it. What is open is whether expansion shares `--resolve-budget`
  with relation resolution or needs a ceiling of its own — two enrichments competing for one allowance
  means the one that runs first starves the other, and which runs first is an implementation accident.
- **Does the `ids` batching still apply?** ADR-0008 batches up to 100 ids per request, which is what
  makes resolution affordable. Confirm the same parameter returns full records rather than a reduced
  projection, and confirm it exists on every entity a deal can point at — that is a fact to look up, not
  a decision.
- **What does a failed expansion do?** ADR-0008 §12's rule is that any resolution failure degrades to
  raw with one `warning` and exit 0. If expansion follows it, a record may carry an expansion on page 1
  and not on page 40, and the `resolved` trailer field would have to grow a sibling or a meaning.
- **Does it interact with field projection?** Ticket 25 is still open. A projection that names fields
  has to say whether it names them on the expanded record too.

Record as an ADR.
