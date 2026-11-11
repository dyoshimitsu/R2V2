// Ignore patterns from the settings tab.

/**
 * Glob matcher for ignore patterns, following .gitignore where it matters:
 *
 * - `*` matches within a path segment, `**` across segments, `?` one character
 * - a pattern without a slash (`.git`, `*.tmp`) matches at any depth
 * - a pattern with a slash (`notes/drafts`), or starting with one (`/todo.md`),
 *   is relative to the vault root
 * - a pattern that matches a folder covers everything beneath it
 */
export function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim();
  const p = trimmed.replace(/^\/+|\/+$/g, "");
  const anyDepth = !trimmed.startsWith("/") && !p.includes("/");
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${anyDepth ? "(?:.*/)?" : ""}${re}(/.*)?$`);
}

/** Compile a newline-separated pattern list into a path predicate. */
export function compileIgnore(patterns: string): (path: string) => boolean {
  const regexps = patterns
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(globToRegExp);
  return (path) => regexps.some((re) => re.test(path));
}

/**
 * What a new installation ignores: version-control and tooling folders, the
 * trash, and the parts of the config folder that describe one device's window
 * layout rather than the vault.
 */
export function defaultIgnorePatterns(configDir: string): string[] {
  return [
    ".git",
    ".trash",
    "node_modules",
    ".DS_Store",
    `${configDir}/workspace.json`,
    `${configDir}/workspace-mobile.json`,
  ];
}

/** Add the defaults to a pattern list, keeping what is already there and its order. */
export function withDefaultIgnores(patterns: string, configDir: string): string {
  const lines = patterns
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (const pattern of defaultIgnorePatterns(configDir)) {
    if (!lines.includes(pattern)) lines.push(pattern);
  }
  return lines.join("\n");
}
