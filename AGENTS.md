# Using `pd` from an agent

`pd` is read-only and emits NDJSON. List commands fetch the complete result by default, so pass `--limit` unless you know the result is small.

Entity search is a distinct verb: `pd deals search Acme`. Search lines are tagged as hits (for example, `deal_search_hit`), not full records. A bounded search returns the best matches, so `--limit 20` is usually useful. `--search-in` chooses where Pipedrive searches; `--fields` chooses what `pd` emits.

## Fetching related records

`pd` never expands or includes a related entity automatically. Join two commands instead, projecting the foreign key from the first command and fetching the complete related records with `--ids`:

```sh
pd deals list --fields title,org_id
pd organizations list --ids 7,9,11
```

`--ids` accepts any number of IDs. The CLI deduplicates them and hides Pipedrive's 100-ID request boundary while preserving the caller's order. An `unmatched_ids` warning means one or more requested records do not exist or are not visible.
