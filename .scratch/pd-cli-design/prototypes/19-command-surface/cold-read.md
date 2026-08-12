# Reading the draft cold, as an agent with the manifest and nothing else

What a model given only `manifest.sample.json` would get wrong, or waste a turn on.

Written against the *draft* manifest. [ADR-0009](../../../../docs/adr/0009-command-surface-and-manifest.md)
fixed items **3** (the `resolved` vocabulary is declared) and **7** (`pd fields list --entity` ships).
Items 1, 2, 4, 5 and 6 stand against the locked manifest and are the known rough edges.

1. **`--limit` versus a page size.** The manifest says `unit: records`, which is right, but nothing
   says what happens *without* it. A cautious agent passes `--limit 100` to everything and never
   discovers the full set. The default `null` reads as "no results" to a careless parser.

2. **`delivery: "streams"` versus `"collects"`.** Useful, but it does not say how long a collected
   command takes. `users list` collects and is fast; a future collected command over 40,000 records
   is 20 seconds of silence (measured in prototype 10). The field describes the mechanism, not the
   cost.

3. **`resolved` on the trailer has values the manifest never lists.** `"none"` appears in the sample
   summary; ADR-0008 also defines `"partial"`. The vocabulary belongs in the manifest, or an agent
   cannot branch on it without seeing every value first.

4. **No cost signal per command.** An agent budgeting its own turns cannot tell that `deals list`
   may cost nine requests and `users get` zero. `requests` is only knowable after the fact — which
   is correct, but silence invites the agent to guess.

5. **`record_type` duplicates the command name.** `deals list` emits `record_type: "deal"`. Harmless,
   but it is the only singular/plural mapping in the whole surface, and an agent constructing a
   command from a record type has to invert it.

6. **The read-only claim appears three times** — `read_only: true`, the description string, and the
   help footer — and an agent still has no way to test it short of trying a write. The refusal
   message in `help-samples.txt` is the only thing that answers a probe cheaply.

7. **Nothing says the account's own shape.** Which resources exist is fixed by `pd`, but which
   *custom fields* exist is per-account. An agent that wants to filter on "Renewal date" has no
   command in the draft that tells it the hash — unless a `fields` command ships (FORK A).
