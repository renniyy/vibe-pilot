/**
 * Ignore engine: built-in boilerplate rules + a pragmatic gitignore parser.
 *
 * The parser supports the gitignore constructs that matter for repo scanning:
 * negation (`!`), directory-only patterns (trailing `/`), anchoring (leading
 * `/` or embedded `/`), `*` / `?` / `**` globs and character classes.
 */

export interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
  source: string;
}

/** Directories that are boilerplate in virtually every repo. */
export const BOILERPLATE_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.output',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.parcel-cache',
  '.cache',
  '.yarn',
  'coverage',
  'vendor',
  'target',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.eggs',
  '.idea',
  '.gradle',
  'Pods',
  'DerivedData',
  'bin',
  'obj',
  '.terraform',
  '.serverless',
]);

/** File globs that are generated artifacts, ignored wherever they appear. */
export const GENERATED_FILE_PATTERNS: RegExp[] = [
  /\.min\.(js|css)$/i,
  /\.min\.(mjs|cjs)$/i,
  /\.map$/i,
  /-lock\.(json|yaml|yml)$/i,
  /^package-lock\.json$/i,
  /^npm-shrinkwrap\.json$/i,
  /^yarn\.lock$/i,
  /^pnpm-lock\.yaml$/i,
  /^poetry\.lock$/i,
  /^poetry\.lock$/i,
  /^uv\.lock$/i,
  /\.tsbuildinfo$/i,
  /\.pyc$/i,
  /\.class$/i,
  /\.o$|\.obj$|\.so(\.|$)|\.dylib$|\.dll$|\.exe$/i,
  /^\.DS_Store$/i,
];

function globToRegex(pattern: string): { regex: string; anchored: boolean } {
  let anchored = false;
  let p = pattern;
  if (p.startsWith('/')) {
    anchored = true;
    p = p.slice(1);
  } else if (p.includes('/')) {
    // A pattern containing a slash (other than trailing) is anchored.
    anchored = true;
  }
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**` matches across separators (and the slash after it).
        re += '.*';
        i++;
        if (p[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      let j = i + 1;
      let cls = '[';
      if (p[j] === '!' || p[j] === '^') {
        cls += '^';
        j++;
      }
      while (j < p.length && p[j] !== ']') cls += p[j++];
      cls += ']';
      if (p[j] === ']') {
        re += cls;
        i = j;
      } else {
        re += '\\[';
      }
    } else {
      re += c.replace(/[.+^$(){}|\\]/g, '\\$&');
    }
  }
  return { regex: anchored ? `^${re}$` : `^(|.*/)${re}$`, anchored };
}

export function parseGitignore(text: string, source: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    // Strip trailing spaces unless escaped (gitignore semantics).
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    const { regex, anchored } = globToRegex(line);
    rules.push({
      negated,
      dirOnly,
      anchored,
      regex: new RegExp(regex),
      source,
    });
  }
  return rules;
}

/**
 * Decide whether a repo-relative posix path is ignored, given the ordered rule
 * stack from the root down to the path's directory. Last matching rule wins.
 */
export function isIgnored(
  relPath: string,
  isDir: boolean,
  ruleStack: IgnoreRule[][]
): boolean {
  let ignored = false;
  for (const rules of ruleStack) {
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) {
        // dir-only rules also match files *inside* the dir, which the
        // `.*/` form below covers for unanchored rules; for anchored rules
        // match a prefix directory.
        if (rule.anchored) {
          const dirPattern = rule.regex.source.replace(/\$$/, '(/.*)?$');
          if (new RegExp(dirPattern).test(relPath)) {
            ignored = !rule.negated;
          }
        } else {
          const dirPattern = rule.regex.source.replace(/\$$/, '(/.*)?$');
          if (new RegExp(dirPattern).test(relPath)) {
            ignored = !rule.negated;
          }
        }
        continue;
      }
      if (rule.regex.test(relPath)) ignored = !rule.negated;
    }
  }
  return ignored;
}

/** True when a path sits inside (or is itself) a built-in boilerplate directory. */
export function isBoilerplateDir(relPath: string, isDir: boolean): boolean {
  const parts = relPath.split('/');
  if (parts.length === 0) return false;
  // A directory whose own name is boilerplate (e.g. root `node_modules/`).
  if (isDir && BOILERPLATE_DIRS.has(parts[parts.length - 1])) return true;
  // Anything nested inside a boilerplate directory at any depth.
  return parts.slice(0, -1).some((p) => BOILERPLATE_DIRS.has(p));
}

/** True when a filename looks like a generated artifact. */
export function isGeneratedFile(basename: string): boolean {
  return GENERATED_FILE_PATTERNS.some((re) => re.test(basename));
}
