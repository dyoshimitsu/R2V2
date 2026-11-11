// The same rule set the Obsidian community directory runs in its review.
import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  globalIgnores(["main.js", "node_modules/", "scripts/", "tests/"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs", "version-bump.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
