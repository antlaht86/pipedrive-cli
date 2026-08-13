/**
 * The two per-user directories — ADR-0021 §8, which keeps ADR-0014 §6's mapping
 * unchanged.
 *
 * | purpose | POSIX                                          | Windows                          |
 * | ------- | ---------------------------------------------- | -------------------------------- |
 * | config  | `$XDG_CONFIG_HOME/pd/`, default `~/.config/pd/` | `%APPDATA%\pd\`                  |
 * | cache   | `$XDG_CACHE_HOME/pd/<fp>/`, default `~/.cache/pd/` | `%LOCALAPPDATA%\pd\<fp>\`     |
 *
 * `platform`, `env` and `home` are parameters rather than reads of the ambient
 * process, so both mappings are testable from either platform. That is also the
 * whole isolation mechanism the spec allows: a test points `XDG_CONFIG_HOME` at
 * a temporary directory, and there is no `PD_TEST_HOME` or test-only flag.
 *
 * The Windows branch joins with `\` explicitly instead of `node:path`, because
 * `path.join` on a POSIX host would produce `/` separators for a Windows path
 * and the test would assert the wrong string on every developer machine.
 */

export type Platform = "win32" | (string & {});

export type PathContext = {
  /** `process.platform`, injected. */
  platform: Platform;
  /** The environment, injected. Empty and unset are the same thing. */
  env: Readonly<Record<string, string | undefined>>;
  /** The user's home directory, injected (`os.homedir()`). */
  home: string;
};

/** An environment variable set to the empty string is not set. */
const envValue = (env: PathContext["env"], name: string): string | undefined => {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
};

/**
 * The one place the platform is branched on. Everything below joins with the
 * separator this returns, so the two mappings differ in their *roots* and their
 * *variable names* rather than in three repeated `platform === "win32"` tests.
 */
const separator = (platform: Platform): string =>
  platform === "win32" ? "\\" : "/";

/**
 * The root the per-user directory hangs off: the named environment variable if
 * it is set, and otherwise the platform's default relative to `home`.
 */
const root = (
  { platform, env, home }: PathContext,
  variable: string,
  fallback: readonly string[],
): string =>
  envValue(env, variable) ?? [home, ...fallback].join(separator(platform));

export const configDir = (context: PathContext): string => {
  const base =
    context.platform === "win32"
      ? root(context, "APPDATA", ["AppData", "Roaming"])
      : root(context, "XDG_CONFIG_HOME", [".config"]);
  return [base, "pd"].join(separator(context.platform));
};

export const credentialsPath = (context: PathContext): string =>
  [configDir(context), "credentials"].join(separator(context.platform));

export type CacheDirContext = PathContext & {
  /** First 16 hex of SHA-256 of the resolved token — ADR-0005 §2. */
  fingerprint: string;
};

export const cacheDirFor = ({
  fingerprint,
  ...context
}: CacheDirContext): string => {
  const base =
    context.platform === "win32"
      ? root(context, "LOCALAPPDATA", ["AppData", "Local"])
      : root(context, "XDG_CACHE_HOME", [".cache"]);
  return [base, "pd", fingerprint].join(separator(context.platform));
};
