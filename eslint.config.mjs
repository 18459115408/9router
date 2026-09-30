import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import globals from "globals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // eslint-config-next does not enable eslint:recommended, and this repo is
  // plain ESM with no TypeScript — so nothing else catches a reference to a
  // variable that was never declared. That is exactly how a botched rename
  // reached origin as a runtime ReferenceError on the request path.
  {
    rules: {
      "no-undef": "error",
    },
  },
  // next's globals cover js/jsx/mjs/ts/tsx/mts/cts, never .cjs: a CommonJS file
  // would start with no globals at all and every node global would read as
  // undefined. The repo has one such file (a plain-node test).
  {
    files: ["**/*.cjs"],
    languageOptions: { globals: globals.node },
  },
  // The service worker runs in ServiceWorkerGlobalScope, where `clients` is a
  // global but not one of the browser globals next provides.
  {
    files: ["public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local agent tooling, gitignored and not project code.
    ".zcode/**",
  ]),
]);

export default eslintConfig;
