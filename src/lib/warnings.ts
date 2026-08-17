/**
 * The `warning` vocabulary — ADR-0002 (the line type) and ADR-0006 §6 (the
 * `kind` discriminator a consumer dispatches on after `type`).
 *
 * This module is the single registry. The spec enumerates the kinds by name and
 * states no total that is not also a list, so the list below is the one place a
 * kind is minted, and every other statement of it — the spec, `AGENTS.md`, the
 * manifest — is a copy of this.
 *
 * ## The eighth kind, minted by ticket 03
 *
 * Seven kinds arrived with ADR-0002 … ADR-0018. ADR-0012 §3 then required a
 * `warning` for a credentials file with permissions looser than `0600`, and
 * ADR-0021 §8 required one for the Windows NTFS gap where `0600` has no
 * equivalent at all — but neither ADR named a `kind`, and ADR-0006 §6 requires
 * one. Both are the same statement about the same file: *the credential file's
 * permissions do not confine it to you*. They share one kind,
 * `credential_file_permissions`.
 *
 * Adding a kind is additive and non-breaking, exactly as adding a `code` is: a
 * consumer that meets an unknown `kind` still knows the line is a `warning` and
 * that the run continued.
 *
 * ## Where a warning goes
 *
 * On a record-streaming command a warning is its own NDJSON line on stdout,
 * `{"type":"warning","kind":…}`. `pd auth status` emits a single JSON object
 * instead of a stream (ADR-0012 §5), so its warnings ride in that object's
 * `warnings` array — the same values, without the `type` tag.
 */

export const WARNING_KINDS = [
  "record_rejected",
  "cache_entry_skipped",
  "owner_resolution_unavailable",
  "unknown_custom_field",
  "resolution_budget_exhausted",
  "unmatched_field_selector",
  "unmatched_ids",
  "credential_file_permissions",
] as const;

export type WarningKind = (typeof WARNING_KINDS)[number];

/**
 * `kind` is interface; `message` is human prose and may change freely. Any
 * further fields are per-kind and documented where that kind is produced.
 */
export type PdWarning = {
  kind: WarningKind;
  message: string;
} & Record<string, unknown>;

/** Any character no field can contain would do; a tab is the least surprising. */
const CAUSE_SEPARATOR = "\t";

/**
 * The one `kind` with a field set worth naming — ADR-0006 §6. `kind`,
 * `resource`, `path` and `issue` are interface; `message` is prose. `id` is
 * best-effort and **omitted** when unrecoverable, never `null`, so a consumer
 * never has to tell "no id" from "id was null".
 */
export type RecordRejected = {
  kind: "record_rejected";
  resource: string;
  id?: number;
  /** Record-relative — `person_id`, never `data.7.person_id`. Empty at the root. */
  path: string;
  /**
   * The zod issue code of the reported cause — or `shadowed`, which the writer
   * raises for a wire field that would shadow a line key (ADR-0029 §6) and which
   * no parse produced.
   */
  issue: string;
  message: string;
};

/**
 * The **cause** of a rejection: `(resource, field path, zod issue code)`. One
 * `warning` line is emitted per distinct cause however many records share it,
 * while `skipped` counts every record (ADR-0006 §5).
 *
 * It lives here, beside the registry that mints the `kind`, rather than in the
 * writer that deduplicates on it: the key is a property of the warning, and a
 * writer that derived it by reaching into an open `Record<string, unknown>`
 * would silently key on `undefined` the day a field is renamed.
 */
export const causeOf = (warning: PdWarning): string =>
  isRecordRejected(warning)
    ? [warning.resource, warning.path, warning.issue].join(CAUSE_SEPARATOR)
    : [warning.kind, warning.message].join(CAUSE_SEPARATOR);

export const isRecordRejected = (
  warning: PdWarning,
): warning is RecordRejected & Record<string, unknown> =>
  warning.kind === "record_rejected";
