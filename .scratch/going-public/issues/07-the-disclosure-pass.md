# 07 — The disclosure pass over the records

**What to build:** every sentence that a public reader would learn something about the author's
employer or the company's Pipedrive account from is either deliberately kept or deliberately gone.
No half-scrub, and each choice is written down.

**Blocked by:** 06

**Status:** done

This ticket absorbs tickets 04 and 05, which were each too small to be worth a context of their own
and which touch the same records ticket 06 opens.

Two disclosures:

- **The employer's name as an npm scope.** A superseded distribution decision proposed publishing
  under a scope that is the employer's name. It survives in that record, in the record that replaced
  it, and in the design map and grilling notes behind them. Nothing about it is confidential; it does
  link the repository to a named company, and that link should be a choice rather than residue from
  a rejected plan. Either leave it, on the grounds that a superseded record is history and history is
  not rewritten, or replace it with a neutral placeholder and say in that record's comments that the
  name was removed before publication.
- **Facts about the company account.** The budget-guard record states that the account this tool is
  built for has never reached its daily token budget, and the testing record states that the live
  suite runs against the real company account with no sandbox tenant. No figures, seats or tier
  names appear, so the disclosure is small — but it is a statement about someone else's account.
  Rewriting the sentences to speak about "the account a run points at" preserves every argument and
  drops the attribution.

The design of the daily budget ceiling is settled and is not reopened here. Only the prose is.

- [x] The employer-name question is answered one way, applied everywhere the name appears, and the
      reasoning is recorded in the relevant record's comments
- [x] No document states an observation about a specific real Pipedrive account
- [x] The budget and testing arguments still hold with the attribution removed
- [x] `bun test`, `bun run gates`, `bun run typecheck` and `bun run lint` stay green

## Comments

**2026-08-20 — the name is replaced, the attributions are gone, the mechanics stay.**

*The employer name.* User's call: replace, do not keep as history. The scope now reads `@scope/pd` in
all nine occurrences across four records — five in
[ADR-0014](../../../docs/adr/0014-distribution.md) (two on §1's install line, one in §4, two in §8),
one in [ADR-0021](../../../docs/adr/0021-distribution-build-from-source.md) §1, one in the design
map's distribution entry, and two in the distribution grilling notes. ADR-0014 carries the reasoning
as an editorial note directly after its header lines, in the italic-note style ticket 06's review
settled on: the name was the author's employer's, the substitution happened before the repository was
made public, and no argument in the record depends on which scope was chosen, only on a scope being
needed at all. The map's "the scoped name is forced because `pd`, `pipedrive-cli` and `pd-cli` are
taken" argument survives the placeholder untouched, and ADR-0021 §1 gained a back-pointer so a reader
who lands there learns the token is a placeholder. The name itself is written nowhere in the tree any
more, this record included — an audit trail does not need to repeat the string it removed.

*The account attributions.* Three sentences stated something about a specific account and all three
are rewritten to the ticket's phrase. ADR-0010 §2's hazard is now unobserved "on the account this
decision was measured against" rather than "on this account" — the qualifier is kept deliberately,
because deleting it would turn a scoped observation into an unqualified universal claim, which
changes the evidence rather than the attribution. Its deciding assumption now reads "the account a
run points at does not reach its daily token budget", with "if that changes" becoming "where that
assumption does not hold" — the assumption-not-a-fact framing is exactly what lets the argument
survive de-attribution, so it is kept verbatim. ADR-0019 §9 now runs against "whatever account the resolved token points at —
a production account, not a sandbox", which keeps the whole sandbox refusal intact, because that
argument was always about schema and emptiness rather than about whose account it is.

*Beyond the two named records.* The phrase "the real company account" also survived in ADR-0021 §9's
supersede prose, in ADR-0031's Context, in the design spec, the design map, the testing grilling
notes and two closed implementation tickets. Every hit is now "a real production account" or "the
account a run points at", and ADR-0021 §9's body no longer calls a recording "the company's recorded
CRM data". This is a token substitution and not a rewrite of any historical argument, so ADR-0031
§5's rule that historical records are left saying what they said then is not disturbed. The auth
research note about installing an OAuth app "into the real company account" went the same way.

*The one concrete datum.* A real deal id appeared three times — in the nullability patch list's
hand-verification, in the ticket that measured the null custom-field drop, and in the comment on the
fixture double that records that measurement. All three now describe the same record without naming
it, and every count, byte figure and value shape is untouched, because those are what the evidence
rests on.

*Deliberately kept.* Everything that says the daily budget belongs to a whole company account, that a
Cloudflare block is company-wide, or that exhausting the pool breaks colleagues' integrations —
ADR-0005, ADR-0010, ADR-0019, ADR-0031 §2, `CONTEXT.md`, `AGENTS.md`, the research files. These are
properties of Pipedrive's billing model, not observations about anyone's account, and the safety
argument for the zero-request default is built on them.

Also kept: [ADR-0030](../../../docs/adr/0030-the-null-custom-field-drops.md)'s measurement — 87 custom
fields defined, four filled, 4259 bytes against 275 — names no account and no record, and it is the
whole evidence for dropping the null keys. And this ticket, ticket 05 and the going-public map quote
or paraphrase the sentences they had removed. An audit trail that cannot say what it scrubbed is not
an audit trail, and the quoted claim — that some account has not hit a budget — carries no figure, no
seat count and no company name.

`AGENTS.md` needed no change, so no rebuild was required. Verified: `bun test` 601 pass, `bun run
gates`, `bun run typecheck` and `bun run lint` all green.

**Not in scope, flagged for ticket 09:** replacing the name in the working tree does not remove it
from git history. A public repository publishes its history, so the flip should account for the scope
name being reachable in old commits.
