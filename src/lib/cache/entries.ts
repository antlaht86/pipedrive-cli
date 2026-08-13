/**
 * The closed cache list — ADR-0005 §1 as amended by ADR-0008 and ADR-0009 §2.
 *
 * Eight entries and nothing else. The rule behind them is "every v2 `*Fields`
 * schema for 24 hours, plus `pipelines`, `stages` and the v1 `users` list", and
 * `projectFields` is absent only because ADR-0009 §2 gave projects no command
 * surface. **No entity records, no result sets, no search results, ever.**
 *
 * `CacheEntryName` is a union of the eight literals rather than a `string`, so
 * "nothing else is ever cached" is a compile error rather than a discipline: a
 * caller cannot ask the store for `deals` because the name does not exist.
 *
 * This module holds names, TTLs and the two on-disk constants and depends on
 * nothing. `store.ts` reads and writes; `commands/cache.ts` reports. Both need
 * the TTL table, and a second copy of it is the one that would be wrong.
 */

export const CACHE_ENTRY_NAMES = [
  "users",
  "dealFields",
  "personFields",
  "organizationFields",
  "productFields",
  "activityFields",
  "pipelines",
  "stages",
] as const;

export type CacheEntryName = (typeof CACHE_ENTRY_NAMES)[number];

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/**
 * ADR-0005 §3. A schema changes when an admin edits the field configuration; the
 * user list changes when a person joins or leaves, which is the more frequent
 * event and the cheaper one to re-fetch.
 */
export const TTL_SECONDS: Record<CacheEntryName, number> = {
  users: HOUR,
  dealFields: DAY,
  personFields: DAY,
  organizationFields: DAY,
  productFields: DAY,
  activityFields: DAY,
  pipelines: DAY,
  stages: DAY,
};

/**
 * ADR-0005 §6: every entry carries a schema version, and a version the running
 * binary does not recognise is treated exactly like a missing entry — silently,
 * because an upgrade rewriting eight entries is expected rather than a signal.
 *
 * It stamps the **file format**, not the record schema. A binary whose zod
 * schemas were regenerated reads an old entry without noticing, which is why the
 * read path treats "no record survived validation" as a miss as well.
 */
export const CACHE_SCHEMA_VERSION = 1;

export const entryFileName = (name: CacheEntryName): string => `${name}.json`;

/**
 * ADR-0010 §7: `pd cache clear`'s target is the credential subtree **minus this
 * file**. An agent that meets an error and tries "clear the cache and retry" —
 * an entirely ordinary recovery reflex — would otherwise delete the one
 * company-wide safety stop and walk straight back into the block.
 *
 * The name is reserved here rather than in ticket 09 because `clear` ships
 * before the sentinel does, and a `clear` written to a name nobody had fixed
 * would delete the sentinel for one release.
 */
export const SENTINEL_FILE = "blocked.json";
