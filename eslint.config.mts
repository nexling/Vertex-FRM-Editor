import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  // Compiled output
  globalIgnores(["out/"]),
  { files: ["**/*.{js,mjs,cjs,ts,mts,cts}"], plugins: { js }, extends: ["js/recommended"] },
  tseslint.configs.recommended,
  // Extension host
  { files: ["src/**/*.ts"], languageOptions: { globals: globals.node } },
  // Webview script
  {
    files: ["media/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.browser, acquireVsCodeApi: "readonly" },
    },
  },
  // Node tests
  {
    files: ["test/**/*.js"],
    languageOptions: { sourceType: "commonjs", globals: globals.node },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
]);
