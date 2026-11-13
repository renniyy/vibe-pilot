import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileInfo, GraphResult } from './types.js';

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const READ_CAP = 1.5 * 1024 * 1024;

/** Dirs whose files are runnable utilities rather than dead code. */
const COLD_EXEMPT_DIRS = new Set([
  'scripts', 'script', 'tools', 'tooling', 'examples', 'example', 'migrations',
  'mocks', 'fixtures', 'typings', 'benches', 'benchmarks', 'setup', 'hack',
]);
const COLD_EXEMPT_FILES = /^(conftest\.py|setup\.py|asgi\.py|wsgi\.py|.*\.d\.ts)$/i;

/* ------------------------------------------------------------------ */
/* helpers                                                              */
/* ------------------------------------------------------------------ */

function readText(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > READ_CAP) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

function readJson(abs: string): Record<string, any> | null {
  const txt = readText(abs);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

/** Resolve a relative module specifier against a directory, TS-style. */
function resolveRelative(dir: string, spec: string, fileMap: Map<string, FileInfo>): string | null {
  const base = dir ? path.posix.join(dir, spec) : spec;
  const joined = path.posix.normalize(base);
  const candidates: string[] = [joined];
  if (/\.(js|mjs|cjs|jsx)$/.test(joined)) {
    // TS ESM convention: `./foo.js` may point at `foo.ts`.
    candidates.push(joined.replace(/\.(js|mjs|cjs|jsx)$/, '.ts'));
    candidates.push(joined.replace(/\.(js|mjs|cjs|jsx)$/, '.tsx'));
  }
  for (const ext of JS_EXTS) candidates.push(joined + ext);
  for (const ext of JS_EXTS) candidates.push(joined + '/index' + ext);
  for (const c of candidates) if (fileMap.has(c)) return c;
  return null;
}

/** Pick the entry specifier out of a package.json `exports` field. */
function entryFromExports(exportsField: any): string | null {
  if (!exportsField) return null;
  if (typeof exportsField === 'string') return exportsField;
  const dot = typeof exportsField === 'object' ? exportsField['.'] ?? exportsField : null;
  if (!dot) return null;
  if (typeof dot === 'string') return dot;
  if (Array.isArray(dot)) return typeof dot[0] === 'string' ? dot[0] : null;
  for (const key of ['import', 'module', 'default', 'require', 'types']) {
    const v = dot[key];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof v.default === 'string') return v.default;
  }
  return null;
}

/** Resolve a package.json style entry spec to a real repo file. */
function resolvePkgEntry(pkgDir: string, spec: string | null, fileMap: Map<string, FileInfo>): string | null {
  if (!spec) return null;
  const norm = spec.startsWith('.') || spec.startsWith('/') ? spec : `./${spec}`;
  const direct = resolveRelative(pkgDir, norm, fileMap);
  if (direct) return direct;
  // Published builds (dist/, lib/, build/) are usually gitignored; the source
  // twin lives in src/ — fall back so entry detection keeps working.
  const remapped = spec.replace(/^(\.\/)?(dist|lib|build|out)\//, 'src/');
  if (remapped !== spec) {
    return resolveRelative(pkgDir, remapped.startsWith('.') ? remapped : `./${remapped}`, fileMap);
  }
  return null;
}

function fallbackEntries(pkgDir: string, fileMap: Map<string, FileInfo>): string | null {
  const candidates = [
    'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.jsx',
    'src/main.ts', 'src/main.tsx', 'src/main.js', 'src/cli.ts', 'src/cli.js',
    'index.js', 'index.ts', 'index.mjs', 'main.js',
  ];
  for (const c of candidates) {
    const p = pkgDir ? `${pkgDir}/${c}` : c;
    if (fileMap.has(p)) return p;
  }
  return null;
}

/** Glob match for workspace patterns like `packages/*` or `apps/**`. */
function globMatchDirs(pattern: string, dirs: string[]): string[] {
  const re = new RegExp(
    '^' + pattern
      .replace(/\/$/, '')
      .split('/')
      .map((seg) => seg
        .replace(/[.+^$(){}|\\]/g, '\\$&')
        .replace(/\*\*/g, '\u00a7')
        .replace(/\*/g, '[^/]*')
        .replace(/\u00a7/g, '.*'))
      .join('/') + '$'
  );
  return dirs.filter((d) => re.test(d));
}

/* ------------------------------------------------------------------ */
/* import extraction                                                    */
/* ------------------------------------------------------------------ */

function extractJsImports(text: string): string[] {
  const specs: string[] = [];
  const patterns: RegExp[] = [
    /^\s*import\s+(?:type\s+)?[^;'"()]*?from\s*["']([^"']+)["']/gm,
    /^\s*export\s+(?:type\s+)?[^;'"()]*?from\s*["']([^"']+)["']/gm,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*import\s+["']([^"']+)["']/gm,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (!m[1]) continue;
      if (/^(data|node|bun|http|https|file):/.test(m[1])) continue;
      specs.push(m[1]);
    }
  }
  return specs;
}

interface PyImport { module: string; level: number; fromNames: string[] | null }

function extractPyImports(text: string): PyImport[] {
  const out: PyImport[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue;
    let m = /^from\s+([.\w]+)\s+import\s+([\w\s,()\\]*)/.exec(trimmed);
    if (m) {
      const raw = m[1];
      const dots = (raw.match(/^[.]+/) || [''])[0];
      const names = m[2]
        .replace(/[()\\]/g, '')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      out.push({ module: raw.slice(dots.length), level: dots.length, fromNames: names });
      continue;
    }
    m = /^import\s+([\w.,\s]+)$/.exec(trimmed);
    if (m) {
      for (const rawPart of m[1].split(',')) {
        const raw = rawPart.trim().split(/\s+as\s+/)[0].trim();
        if (!raw) continue;
        const dots = (raw.match(/^[.]+/) || [''])[0];
        out.push({ module: raw.slice(dots.length), level: dots.length, fromNames: null });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* graph construction                                                   */
/* ------------------------------------------------------------------ */

interface PkgAlias { name: string; dir: string; entry: string | null }

export function buildGraph(root: string, files: FileInfo[]): GraphResult {
  const absRoot = path.resolve(root);
  const fileMap = new Map(files.map((f) => [f.path, f] as const));

  const imports = new Map<string, string[]>();
  const importedBy = new Map<string, string[]>();
  const entries: string[] = [];
  const workspacePackages: { name: string; dir: string; entry: string | null }[] = [];
  const pkgAliases = new Map<string, PkgAlias>();
  const pathAliases: { prefix: string; target: string; baseDir: string }[] = [];

  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    let a = imports.get(from);
    if (!a) { a = []; imports.set(from, a); }
    if (!a.includes(to)) a.push(to);
    let b = importedBy.get(to);
    if (!b) { b = []; importedBy.set(to, b); }
    if (!b.includes(from)) b.push(from);
  };

  /* ---- package.json: root + monorepo workspaces ----------------------
     The graph receives the FULL file list (incl. config class) so
     package.json/tsconfig stay visible for entry detection. */
  function registerPackage(dir: string, pkg: Record<string, any>) {
    const name = typeof pkg.name === 'string' ? pkg.name : dir || '.';
    let entry: string | null = null;
    for (const spec of [
      entryFromExports(pkg.exports),
      typeof pkg.module === 'string' ? pkg.module : null,
      typeof pkg.main === 'string' ? pkg.main : null,
    ]) {
      entry = resolvePkgEntry(dir, spec, fileMap);
      if (entry) break;
    }
    if (!entry) entry = fallbackEntries(dir, fileMap);
    pkgAliases.set(name, { name, dir, entry });
    workspacePackages.push({ name, dir: dir || '.', entry });
    if (entry && !entries.includes(entry)) entries.push(entry);

    const bins = typeof pkg.bin === 'string' ? { default: pkg.bin } : pkg.bin;
    if (bins && typeof bins === 'object') {
      for (const bspec of Object.values(bins)) {
        if (typeof bspec !== 'string') continue;
        const b = resolvePkgEntry(dir, bspec, fileMap);
        if (b && !entries.includes(b)) entries.push(b);
      }
    }

    const tsRel = dir ? `${dir}/tsconfig.json` : 'tsconfig.json';
    if (fileMap.has(tsRel)) registerTsPaths(path.join(absRoot, dir));
  }

  function registerTsPaths(absTsDir: string) {
    const ts = readJson(path.join(absTsDir, 'tsconfig.json'));
    const co = ts?.compilerOptions ?? {};
    const paths: Record<string, string[]> = co.paths ?? {};
    if (!co.baseUrl && !Object.keys(paths).length) return;
    const baseUrl: string = co.baseUrl ?? '.';
    const relTs = path.relative(absRoot, absTsDir) || '.';
    const baseDir = path.posix.normalize(path.posix.join(relTs, baseUrl));
    for (const [prefix, targets] of Object.entries(paths)) {
      const target = targets?.[0];
      if (typeof target !== 'string') continue;
      pathAliases.push({ prefix, target, baseDir: baseDir === '.' ? '' : baseDir });
    }
  }

  const dirs = [...new Set(files.map((f) => path.posix.dirname(f.path)).filter((d) => d !== '.'))];
  const rootPkg = fileMap.has('package.json') ? readJson(path.join(absRoot, 'package.json')) : null;
  if (rootPkg) {
    const wsRaw = Array.isArray(rootPkg.workspaces) ? rootPkg.workspaces : rootPkg.workspaces?.packages;
    const patterns: string[] = Array.isArray(wsRaw) ? wsRaw.map((p: string) => p.replace(/\/$/, '')) : [];
    for (const pattern of patterns) {
      const dirPattern = /\.\w+$/.test(pattern) ? pattern.replace(/\/[^/]+$/, '') : pattern;
      for (const dir of globMatchDirs(dirPattern, dirs)) {
        if (!fileMap.has(`${dir}/package.json`)) continue;
        const pkg = readJson(path.join(absRoot, dir, 'package.json'));
        if (pkg) registerPackage(dir, pkg);
      }
    }
    registerPackage('', rootPkg);
  }

  /* ---- python module map + entry heuristics ------------------------ */
  const pyModuleMap = new Map<string, string>();
  for (const f of files) {
    if (!f.path.endsWith('.py')) continue;
    const parts = f.path.replace(/\.py$/, '').split('/');
    if (parts[parts.length - 1] === '__init__') parts.pop();
    if (parts.length === 0) continue;
    pyModuleMap.set(parts.join('.'), f.path);
  }
  for (const c of [
    'main.py', 'app.py', 'manage.py', 'run.py', 'cli.py', 'server.py', '__main__.py',
    'src/main.py', 'src/app.py', 'src/run.py', 'src/cli.py', 'src/__main__.py',
  ]) {
    if (fileMap.has(c) && !entries.includes(c)) entries.push(c);
  }
  // single-package layout: src/<pkg>/__init__.py or <pkg>/__init__.py
  const depth = (d: string) => d.split('/').length;
  for (const parent of ['src', '']) {
    const prefix = parent ? `${parent}/` : '';
    const level = parent ? 2 : 1;
    const pkgDirs = dirs.filter((d) => d.startsWith(prefix) && depth(d) === level);
    for (const d of pkgDirs.slice(0, 4)) {
      const init = `${d}/__init__.py`;
      if (fileMap.has(init) && !entries.includes(init)) entries.push(init);
    }
  }

  /* ---- walk sources, extract + resolve imports --------------------- */
  function resolveJsSpec(spec: string, dir: string): string | null {
    if (spec.startsWith('./') || spec.startsWith('../')) {
      return resolveRelative(dir, spec, fileMap);
    }
    if (spec.startsWith('/')) return null;
    // bare specifier: workspace packages by longest name prefix
    let best: PkgAlias | null = null;
    for (const alias of pkgAliases.values()) {
      if (spec === alias.name || spec.startsWith(`${alias.name}/`)) {
        if (!best || alias.name.length > best.name.length) best = alias;
      }
    }
    if (best) {
      if (spec === best.name) return best.entry && fileMap.has(best.entry) ? best.entry : null;
      const sub = spec.slice(best.name.length + 1);
      const viaPkg = resolveRelative(best.dir, `./${sub}`, fileMap);
      if (viaPkg) return viaPkg;
      return best.entry && fileMap.has(best.entry) ? best.entry : null;
    }
    // tsconfig path aliases, longest prefix wins
    let bestPat: { prefix: string; target: string; baseDir: string } | null = null;
    for (const pa of pathAliases) {
      const starBase = pa.prefix.endsWith('*') ? pa.prefix.slice(0, -1) : pa.prefix;
      if (spec === pa.prefix || (starBase && spec.startsWith(starBase)) || spec.startsWith(`${pa.prefix}/`)) {
        if (!bestPat || pa.prefix.length > bestPat.prefix.length) bestPat = pa;
      }
    }
    if (bestPat) {
      const starBase = bestPat.prefix.endsWith('*') ? bestPat.prefix.slice(0, -1) : bestPat.prefix;
      const rest = spec.slice(starBase.length).replace(/^[/.]/, '');
      const target = bestPat.target.replace(/\*$/, '');
      const viaAlias = resolveRelative(bestPat.baseDir || '.', path.posix.join(target, rest), fileMap);
      if (viaAlias) return viaAlias;
    }
    return null; // external dependency or builtin: no repo edge
  }

  /**
   * Resolve a python module reference to its file and package directory.
   * Relative specs turn leading dots into directory hops
   * (`from .agent.service import Z` -> ./agent/service.py).
   */
  function resolvePyModule(module: string, level: number, dir: string): { file: string | null; pkgDir: string | null } {
    if (level > 0) {
      const parts = dir ? dir.split('/') : [];
      const up = level - 1;
      if (up > parts.length) return { file: null, pkgDir: null };
      const baseParts = parts.slice(0, parts.length - up);
      const segs = module ? module.split('.') : [];
      const target = [...baseParts, ...segs].filter(Boolean).join('/');
      if (!target) return { file: null, pkgDir: null };
      if (fileMap.has(`${target}.py`)) {
        return { file: `${target}.py`, pkgDir: dirnameOf(target) };
      }
      if (fileMap.has(`${target}/__init__.py`)) return { file: `${target}/__init__.py`, pkgDir: target };
      return { file: null, pkgDir: null };
    }
    if (!module) return { file: null, pkgDir: null };
    const direct = pyModuleMap.get(module);
    if (direct) {
      return { file: direct, pkgDir: pkgDirOf(direct) };
    }
    const parent = module.split('.').slice(0, -1).join('.');
    const last = module.split('.').pop()!;
    if (parent) {
      const parentFile = pyModuleMap.get(parent);
      if (parentFile) {
        const parentDir = pkgDirOf(parentFile);
        if (fileMap.has(`${parentDir}/${last}.py`)) return { file: `${parentDir}/${last}.py`, pkgDir: parentDir };
        if (fileMap.has(`${parentDir}/${last}/__init__.py`)) return { file: `${parentDir}/${last}/__init__.py`, pkgDir: `${parentDir}/${last}` };
        return { file: parentFile, pkgDir: parentDir };
      }
    }
    return { file: null, pkgDir: null };
  }

  function pkgDirOf(file: string): string {
    if (file.endsWith('__init__.py')) {
      const dir = file.slice(0, -'__init__.py'.length - 1);
      return dir;
    }
    return dirnameOf(file);
  }

  function dirnameOf(p: string): string {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }

  for (const f of files) {
    if (f.oversize) continue;
    const isJs = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(f.path);
    const isPy = f.path.endsWith('.py');
    if (!isJs && !isPy) continue;
    const text = readText(path.join(absRoot, f.path));
    if (!text) continue;
    const dir = path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path);
    if (isJs) {
      for (const spec of extractJsImports(text)) {
        const resolved = resolveJsSpec(spec, dir);
        if (resolved) addEdge(f.path, resolved);
      }
    } else {
      for (const imp of extractPyImports(text)) {
        const { file, pkgDir } = resolvePyModule(imp.module, imp.level, dir);
        if (file) addEdge(f.path, file);
        // plain dotted imports execute every ancestor __init__.py
        if (imp.fromNames === null && imp.module.includes('.') && file) {
          const segs = imp.module.split('.');
          for (let i = 1; i < segs.length; i++) {
            const anc = pyModuleMap.get(segs.slice(0, i).join('.'));
            if (anc) addEdge(f.path, anc);
          }
        }
        // from-imports: each name may itself be a submodule
        if (imp.fromNames && pkgDir) {
          for (const name of imp.fromNames) {
            if (fileMap.has(`${pkgDir}/${name}.py`)) addEdge(f.path, `${pkgDir}/${name}.py`);
            else if (fileMap.has(`${pkgDir}/${name}/__init__.py`)) addEdge(f.path, `${pkgDir}/${name}/__init__.py`);
          }
        }
      }
    }
  }

  /* ---- reachability -------------------------------------------------- */
  const reachable = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const cur = queue.pop()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const next of imports.get(cur) ?? []) queue.push(next);
  }

  const cold = files
    .filter((f) => f.class === 'source' && !f.path.endsWith('.d.ts'))
    .filter((f) => !/\.(test|spec)\.[a-z]+$/.test(f.path))
    .filter((f) => !reachable.has(f.path))
    .filter((f) => !f.path.split('/').some((p) => COLD_EXEMPT_DIRS.has(p)))
    .filter((f) => !COLD_EXEMPT_FILES.test(f.path))
    .map((f) => f.path);

  let edgeCount = 0;
  for (const list of imports.values()) edgeCount += list.length;

  return { imports, importedBy, entries, reachable, cold, edgeCount, workspacePackages };
}
