# Exposing v1-only resources through a v2-generated client

Type: grilling
Status: open

Blocked by: 04, 06

## Question

Ticket 04 says some resources exist only in v1. How do they reach the command surface?

- Generate a second client from the v1 spec, hand-write a narrow wrapper for the specific v1 endpoints needed, or do without those resources. Locked point 2 forbids hand-writing a client, so a hand-written wrapper needs to be argued as something else — or dropped.
- If a second generated client, how both live in one project without collisions, and how both are forced through the single HTTP client module of locked point 7.
- Whether the version is visible to the caller. An agent asking for a resource should not need to know which API version serves it, but pagination and error shapes may differ enough to leak.
- What differs between v1 and v2 responses for the same conceptual resource, and whether `pd` normalises them or exposes the difference.
- Whether the field-schema endpoints ticket 03 needs are v1, which would make v1 support mandatory rather than optional.
- How the incomplete migration is handled over time — what happens to the command surface when a v1-only resource gains a v2 endpoint.

Record as an ADR.
