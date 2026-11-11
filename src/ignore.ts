// Ignore patterns from the settings tab.

/**
 * Simple glob matcher for exclude patterns. `*` matches within a path
 * segment, `**` matches across segments. A pattern also matches everything
 * beneath a matching folder.
 */
export function globToRegExp(pattern: string): RegExp {
  const p = pattern.trim().replace(/^\/+|\/+$/g, "");
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
  return new RegExp(`^${re}(/.*)?$`);
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
