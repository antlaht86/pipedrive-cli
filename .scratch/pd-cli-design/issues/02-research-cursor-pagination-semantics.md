# Cursor pagination semantics in the Pipedrive v2 API

Type: research
Status: resolved

## Question

How does v2 cursor pagination actually behave, and where does it not apply?

- The exact request and response fields — cursor parameter name, where the next cursor appears, and how the last page is signalled.
- The `limit` maximum, and whether it differs by endpoint.
- Which v2 collection endpoints use cursor pagination and which still use offset or something else.
- Cursor lifetime and stability. Does a cursor expire? What happens when records are created or modified mid-walk — are records skipped, duplicated, or is the snapshot stable?
- Whether sort order is guaranteed and controllable, since a stable order is what makes a resumable partial walk meaningful.
- Whether a total count is available, and whether obtaining it costs an extra request.

This feeds the output-format, pagination-bounding and budget-guard decisions, especially the question of whether a stopped run can be resumed from a cursor rather than restarted.

## Answer

Findings: [research/02-cursor-pagination-semantics.md](../research/02-cursor-pagination-semantics.md).

**Cursor lifetime and stability are entirely undocumented.** No Pipedrive primary source states a TTL, an expiry, an invalidation condition, a snapshot guarantee, or what a walk does when records change mid-walk. The one place Pipedrive calls cursor pagination "stable" is a performance blurb, not a contract, and must not be read as snapshot isolation. Circumstantial evidence says the cursors are keyset markers rather than snapshot handles — which implies concurrent modification can skip or duplicate records. Any resumption design must treat this as unknown.

**There is no total count anywhere in v2.** No `total`, `count`, or `more_items_in_collection`; `additional_data` carries `next_cursor` and nothing else; no `get_summary` equivalent exists on any of the 85 paths. Pre-flight estimation of a walk's size is therefore impossible without walking it.

40 v2 endpoints are cursor-paginated; some collection endpoints do not paginate at all; and several resources have no v2 equivalent and remain offset-paginated in v1. Sort order is controllable on some endpoints and not others.
