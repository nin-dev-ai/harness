import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { LAYERS, ALL_PACKAGES } from "./layers.js";

const layerRules = Object.entries(LAYERS).map(([pkg, allowed]) => {
  const forbidden = ALL_PACKAGES.filter((p) => p !== pkg && !allowed.includes(p));
  const dir = pkg === "cli" ? "apps/cli" : `packages/${pkg}`;
  return {
    files: [`${dir}/**/*.{ts,tsx}`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: forbidden.length
            ? [
                {
                  group: forbidden.flatMap((p) => [`@harness/${p}`, `@harness/${p}/*`]),
                  message: `Layering: @harness/${pkg} may only import ${allowed.length ? allowed.map((a) => "@harness/" + a).join(", ") : "nothing from @harness"}.`,
                },
                { group: ["../../*/src/*", "../../../*/src/*"], message: "Import other packages by name, not by relative path." },
              ]
            : [],
        },
      ],
    },
  };
});

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**", "fixtures/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", setTimeout: "readonly", setInterval: "readonly", clearTimeout: "readonly" } },
  },
  ...layerRules,
);
