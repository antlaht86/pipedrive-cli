# 07 — The disclosure pass over the records

**What to build:** every sentence that a public reader would learn something about the author's
employer or the company's Pipedrive account from is either deliberately kept or deliberately gone.
No half-scrub, and each choice is written down.

**Blocked by:** 06

**Status:** ready-for-agent

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

- [ ] The employer-name question is answered one way, applied everywhere the name appears, and the
      reasoning is recorded in the relevant record's comments
- [ ] No document states an observation about a specific real Pipedrive account
- [ ] The budget and testing arguments still hold with the attribution removed
- [ ] `bun test`, `bun run gates`, `bun run typecheck` and `bun run lint` stay green
