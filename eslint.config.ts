import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Baseline lint config. The mandatory gates of ADR-0019 §8 — the
 * `no-restricted-imports` ban on `**\/generated/**` outside the client module —
 * arrive with ticket 02, when there is a generated client to ban.
 *
 * ADR-0021 §2 removed the ban on `Bun.*` and `bun:*`: Bun is the only runtime.
 */
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
);
