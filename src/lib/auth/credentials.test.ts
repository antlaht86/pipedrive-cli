import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fingerprintOf,
  resolveCredential,
  windowsPermissionCaveat,
} from "./credentials.ts";

/**
 * ADR-0012 §3 (the precedence chain), §7 (a missing credential is `auth`,
 * exit 1, naming every tier).
 *
 * Isolation is `XDG_CONFIG_HOME` pointed at a temporary directory — the
 * mechanism the spec allows. There is no test-only flag or variable.
 */

const workspace = mkdtempSync(join(tmpdir(), "pd-credentials-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

let seq = 0;
let configHome: string;
let credentials: string;

const posix = () => ({
  platform: "linux" as const,
  home: join(workspace, "home"),
  env: { XDG_CONFIG_HOME: configHome },
});

beforeEach(() => {
  seq += 1;
  configHome = join(workspace, `cfg-${seq}`);
  mkdirSync(join(configHome, "pd"), { recursive: true });
  credentials = join(configHome, "pd", "credentials");
});

const writeToken = (path: string, token: string, mode = 0o600): void => {
  writeFileSync(path, token);
  chmodSync(path, mode);
};

describe("the fingerprint", () => {
  test("is the first 16 hex characters of the SHA-256 of the token", () => {
    // Reference value for the SHA-256 of the empty string.
    expect(fingerprintOf("")).toBe("e3b0c44298fc1c14");
  });

  test("has 16 characters", () => {
    expect(fingerprintOf("some-token")).toHaveLength(16);
  });

  test("never contains the token", () => {
    expect(fingerprintOf("some-token")).not.toContain("some-token");
  });
});

describe("the precedence chain", () => {
  test("--token-file wins over both lower tiers", () => {
    const explicit = join(workspace, `explicit-${seq}`);
    writeToken(explicit, "from-flag\n");
    writeToken(credentials, "from-config");

    const result = resolveCredential({
      ...posix(),
      env: { ...posix().env, PD_API_TOKEN: "from-env" },
      tokenFile: explicit,
    });

    expect(result._unsafeUnwrap().tier).toBe("token-file");
    expect(result._unsafeUnwrap().token).toBe("from-flag");
    expect(result._unsafeUnwrap().path).toBe(explicit);
  });

  test("PD_API_TOKEN wins over the config file", () => {
    writeToken(credentials, "from-config");

    const result = resolveCredential({
      ...posix(),
      env: { ...posix().env, PD_API_TOKEN: "from-env" },
    });

    expect(result._unsafeUnwrap().tier).toBe("env");
    expect(result._unsafeUnwrap().token).toBe("from-env");
    expect(result._unsafeUnwrap().path).toBeUndefined();
  });

  test("the config file is the last tier", () => {
    writeToken(credentials, "from-config\n");

    const result = resolveCredential(posix());

    expect(result._unsafeUnwrap().tier).toBe("config-file");
    expect(result._unsafeUnwrap().token).toBe("from-config");
    expect(result._unsafeUnwrap().path).toBe(credentials);
  });

  test("an empty PD_API_TOKEN is not a credential", () => {
    writeToken(credentials, "from-config");

    const result = resolveCredential({
      ...posix(),
      env: { ...posix().env, PD_API_TOKEN: "   " },
    });

    expect(result._unsafeUnwrap().tier).toBe("config-file");
  });

  test("reads the config file from %APPDATA%\\pd on Windows", () => {
    // `%APPDATA%\pd\credentials` is not a path a POSIX host can hold, so the
    // Windows tier is reached through the injected reader. The path it is asked
    // for is the assertion.
    const asked: string[] = [];

    const result = resolveCredential({
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      readFile: (path) => {
        asked.push(path);
        return { text: "from-windows-config\r\n", mode: 0o600 };
      },
    });

    expect(asked).toEqual(["C:\\Users\\Ada\\AppData\\Roaming\\pd\\credentials"]);
    expect(result._unsafeUnwrap().tier).toBe("config-file");
    expect(result._unsafeUnwrap().token).toBe("from-windows-config");
  });
});

describe("no credential anywhere", () => {
  const missing = () => resolveCredential(posix())._unsafeUnwrapErr();

  test("is auth, exit 1, retry never", () => {
    expect(missing().code).toBe("auth");
    expect(missing().exit_code).toBe(1);
    expect(missing().retry).toBe("never");
  });

  test("names every tier searched, in order", () => {
    const { message } = missing();
    expect(message).toContain("--token-file");
    expect(message.indexOf("--token-file")).toBeLessThan(
      message.indexOf("PD_API_TOKEN"),
    );
    expect(message.indexOf("PD_API_TOKEN")).toBeLessThan(
      message.indexOf(credentials),
    );
  });

  test("names the config path it looked at", () => {
    expect(missing().message).toContain(credentials);
  });

  test("treats a whitespace-only config file as no credential", () => {
    writeToken(credentials, "\n  \n");
    expect(resolveCredential(posix())._unsafeUnwrapErr().code).toBe("auth");
  });
});

describe("an unreadable --token-file", () => {
  test("is usage, exit 2, and does not fall through to a lower tier", () => {
    writeToken(credentials, "from-config");

    const error = resolveCredential({
      ...posix(),
      env: { ...posix().env, PD_API_TOKEN: "from-env" },
      tokenFile: join(workspace, "nope"),
    })._unsafeUnwrapErr();

    expect(error.code).toBe("usage");
    expect(error.exit_code).toBe(2);
  });

  test("echoes the path back, because no argument value is sensitive", () => {
    const path = join(workspace, "nope");
    const error = resolveCredential({
      ...posix(),
      tokenFile: path,
    })._unsafeUnwrapErr();

    expect(error.message).toContain(path);
  });

  test("is usage when the file exists but holds only whitespace", () => {
    const empty = join(workspace, `empty-${seq}`);
    writeToken(empty, "\n");

    expect(
      resolveCredential({ ...posix(), tokenFile: empty })._unsafeUnwrapErr().code,
    ).toBe("usage");
  });
});

describe("file permissions", () => {
  test("0600 produces no warning", () => {
    writeToken(credentials, "token", 0o600);
    expect(resolveCredential(posix())._unsafeUnwrap().warnings).toEqual([]);
  });

  test("a group- or world-readable file produces one warning and continues", () => {
    writeToken(credentials, "token", 0o644);

    const credential = resolveCredential(posix())._unsafeUnwrap();

    expect(credential.token).toBe("token");
    expect(credential.warnings).toHaveLength(1);
    expect(credential.warnings[0]?.kind).toBe("credential_file_permissions");
    expect(credential.warnings[0]?.["path"]).toBe(credentials);
  });

  test("the warning names the mode it found", () => {
    writeToken(credentials, "token", 0o644);
    expect(resolveCredential(posix())._unsafeUnwrap().warnings[0]?.["mode"]).toBe(
      "0644",
    );
  });

  test("a loose --token-file warns on the same grounds", () => {
    const explicit = join(workspace, `loose-${seq}`);
    writeToken(explicit, "token", 0o666);

    const credential = resolveCredential({
      ...posix(),
      tokenFile: explicit,
    })._unsafeUnwrap();

    expect(credential.warnings[0]?.kind).toBe("credential_file_permissions");
  });

  test("the env tier has no file and so no permission warning", () => {
    const credential = resolveCredential({
      ...posix(),
      env: { ...posix().env, PD_API_TOKEN: "from-env" },
    })._unsafeUnwrap();

    expect(credential.warnings).toEqual([]);
  });

  test("Windows emits no mode warning, because 0600 has no NTFS equivalent", () => {
    const credential = resolveCredential({
      platform: "win32",
      home: "C:\\Users\\Ada",
      env: { APPDATA: "C:\\Users\\Ada\\AppData\\Roaming" },
      readFile: () => ({ text: "token", mode: 0o666 }),
    })._unsafeUnwrap();

    expect(credential.warnings).toEqual([]);
  });
});

describe("the Windows permission caveat", () => {
  // ADR-0021 §8: `pd auth status` carries it, no other command does, so the
  // resolver above does not emit it and this builds it separately.
  test("is the same kind as the POSIX warning", () => {
    expect(windowsPermissionCaveat("C:\\x\\credentials").kind).toBe(
      "credential_file_permissions",
    );
  });

  test("names the file and states the gap", () => {
    const warning = windowsPermissionCaveat("C:\\x\\credentials");
    expect(warning["path"]).toBe("C:\\x\\credentials");
    expect(warning.message).toContain("NTFS");
  });
});
