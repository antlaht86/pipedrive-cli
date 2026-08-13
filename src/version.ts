/**
 * Version stamping — ADR-0021 §6.
 *
 * `pd --version` prints the base semver from `package.json` plus semver build
 * metadata naming the commit the binary was built from:
 *
 * | built from                              | prints                  |
 * | --------------------------------------- | ----------------------- |
 * | a clean checkout at a release tag        | `1.0.0`                 |
 * | a clean checkout not at a release tag    | `1.0.0+g3f9a1c2`        |
 * | a checkout with uncommitted changes      | `1.0.0+g3f9a1c2.dirty`  |
 *
 * Build metadata is ignored in semver precedence comparison, so the suffix does
 * not affect the contract in ADR-0021 §6.
 */

export type VersionStampInput = {
  /** The `version` field of `package.json`. */
  version: string;
  /** Abbreviated commit hash, without a `g` prefix. */
  sha: string;
  /** `HEAD` carries the release tag for `version` (`v<version>`). */
  atReleaseTag: boolean;
  /** The working tree has uncommitted changes. */
  dirty: boolean;
};

export const stampVersion = ({
  version,
  sha,
  atReleaseTag,
  dirty,
}: VersionStampInput): string => {
  if (dirty) return `${version}+g${sha}.dirty`;
  if (atReleaseTag) return version;
  return `${version}+g${sha}`;
};
