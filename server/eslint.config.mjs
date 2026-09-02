import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import pluginPrettier from "eslint-plugin-prettier";
import configPrettier from "eslint-config-prettier";
import unusedImports from "eslint-plugin-unused-imports";

export default defineConfig([
  { ignores: ["__tests__/**", "**/syncStaticLists.mjs"] },
  // #149: `__tests__` is ignored outright, but `__testHelpers__` is LINTED — the
  // helpers are shared production-shaped modules that several suites import, so a
  // dead variable or a bad import there breaks callers, whereas a suite is
  // self-contained. What they need is the jest globals: CI measured 60
  // `'jest' is not defined` errors under `no-undef` because they were linted as
  // application source. (TL-1 ruling d410f46ee.)
  {
    files: ["__testHelpers__/**/*.{js,mjs,cjs}"],
    languageOptions: { globals: { ...globals.jest } },
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js, prettier: pluginPrettier, "unused-imports": unusedImports },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      ...configPrettier.rules,
      "prettier/prettier": "error",
      "no-case-declarations": "off",
      "no-prototype-builtins": "off",
      "no-async-promise-executor": "off",
      "no-extra-boolean-cast": "off",
      "no-empty": "off",
      "no-unused-private-class-members": "warn",
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
]);
