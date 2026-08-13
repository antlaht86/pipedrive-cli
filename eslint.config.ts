import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * ADR-0021 §2 removed the ban on `Bun.*` and `bun:*`: Bun is the only runtime.
 *
 * The `no-restricted-imports` rule below is read-only layer (c) of ADR-0013 §1,
 * and it runs in CI. It is a path rule rather than a convention, so it survives
 * a refactor that moves a call site around.
 *
 * The generated directories stay in `ignores`: that is "do not lint generated
 * code", which is a separate question from "do not import it".
 */
const CLIENT_MODULE = "src/lib/pipedrive/**";

const GENERATED_IMPORT_BAN = {
  patterns: [
    {
      group: ["**/generated", "**/generated/**"],
      message:
        "The generated Pipedrive SDK is reachable only from src/lib/pipedrive/**. " +
        "Every HTTP call goes through the one client module, which owns the " +
        "non-GET refusal, the rate limit, the retry and the budget.",
    },
  ],
};
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "src/**/generated/**", ".scratch/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { PD_VERSION: "readonly" },
    },
  },
  {
    rules: {
      "no-restricted-imports": ["error", GENERATED_IMPORT_BAN],
    },
  },
  {
    files: [CLIENT_MODULE],
    rules: {
      "no-restricted-imports": "off",
    },
  },
);
