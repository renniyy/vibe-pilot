import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EngineResult, FileClass, FileInfo, ProjectMeta } from './types.js';

const FRAMEWORK_HINTS: [RegExp, string][] = [
  [/"react"/, 'React'],
  [/"vue"/, 'Vue'],
  [/"svelte"/, 'Svelte'],
  [/"@angular\/core"/, 'Angular'],
  [/"next"/, 'Next.js'],
  [/"nuxt"/, 'Nuxt'],
  [/"astro"/, 'Astro'],
  [/"express"/, 'Express'],
  [/"fastify"/, 'Fastify'],
  [/"koa"/, 'Koa'],
  [/"nest"/, 'NestJS'],
  [/"hapi"/, 'Hapi'],
  [/"electron"/, 'Electron'],
  [/"prisma"/, 'Prisma'],
  [/"typeorm"/, 'TypeORM'],
  [/"mongoose"/, 'Mongoose'],
  [/"drizzle-orm"/, 'Drizzle'],
  [/"tailwindcss"/, 'Tailwind CSS'],
  [/"vite"/, 'Vite'],
  [/"webpack"/, 'Webpack'],
  [/"rollup"/, 'Rollup'],
  [/"jest"/, 'Jest'],
  [/"vitest"/, 'Vitest'],
  [/"mocha"/, 'Mocha'],
  [/"playwright"/, 'Playwright'],
  [/"@playwright\/test"/, 'Playwright'],
  [/"cypress"/, 'Cypress'],
  [/"@modelcontextprotocol\/sdk"/, 'MCP SDK'],
  [/"commander"/, 'Commander'],
  [/"zod"/, 'Zod'],
  [/"typescript"/, 'TypeScript'],
  [/"graphql"/, 'GraphQL'],
  [/"docusaurus"/, 'Docusaurus'],
  [/"vitepress"/, 'VitePress'],
];

function readJson(abs: string): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function langOf(f: FileInfo): string | null {
  const ext = f.path.split('.').pop()!.toLowerCase();
  const map: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript',
    js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', rb: 'Ruby',
    php: 'PHP', swift: 'Swift', cs: 'C#', c: 'C', cpp: 'C++', h: 'C',
    hpp: 'C++', sh: 'Shell', vue: 'Vue', svelte: 'Svelte', astro: 'Astro',
    scala: 'Scala', dart: 'Dart', sol: 'Solidity', graphql: 'GraphQL',
  };
  return map[ext] ?? null;
}

export function detectMeta(root: string, files: FileInfo[], enginePkgs: { name: string }[]): ProjectMeta {
  const absRoot = path.resolve(root);
  const pkg = readJson(path.join(absRoot, 'package.json'));
  const pyproject = fs.existsSync(path.join(absRoot, 'pyproject.toml')) ? 'pyproject.toml' : null;
  const requirements = fs.existsSync(path.join(absRoot, 'requirements.txt')) ? 'requirements.txt' : null;

  // language share by source-file count
  const langCount = new Map<string, number>();
  for (const f of files) {
    if (f.class !== 'source') continue;
    const lang = langOf(f);
    if (lang) langCount.set(lang, (langCount.get(lang) ?? 0) + 1);
  }
  const languages = [...langCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .filter(([, n]) => n >= 3)
    .slice(0, 6)
    .map(([l]) => l);

  const frameworks: string[] = [];
  if (pkg) {
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    for (const [re, label] of FRAMEWORK_HINTS) {
      if (frameworks.includes(label)) continue;
      for (const key of Object.keys(deps)) if (re.test(key)) { frameworks.push(label); break; }
    }
  }

  const scripts: Record<string, string> = {};
  if (pkg?.scripts) {
    for (const [k, v] of Object.entries(pkg.scripts)) if (typeof v === 'string') scripts[k] = v;
  }

  const workspaces: string[] = [];
  const wsRaw = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (Array.isArray(wsRaw)) workspaces.push(...enginePkgs.map((p) => p.name));

  let packageManager: string | null = null;
  if (fs.existsSync(path.join(absRoot, 'pnpm-lock.yaml'))) packageManager = 'pnpm';
  else if (fs.existsSync(path.join(absRoot, 'yarn.lock'))) packageManager = 'yarn';
  else if (fs.existsSync(path.join(absRoot, 'package-lock.json'))) packageManager = 'npm';
  else if (fs.existsSync(path.join(absRoot, 'bun.lockb')) || fs.existsSync(path.join(absRoot, 'bun.lock'))) packageManager = 'bun';

  return {
    name: pkg?.name ?? path.basename(absRoot),
    description: typeof pkg?.description === 'string' ? pkg.description : '',
    languages,
    frameworks: frameworks.slice(0, 8),
    packageManager,
    python: Boolean(pyproject || requirements || langCount.get('Python')),
    license: pkg?.license ?? null,
    scripts,
    workspaces,
    tsconfigPaths: fs.existsSync(path.join(absRoot, 'tsconfig.json')),
  };
}

export function classesBreakdown(files: FileInfo[]): Record<FileClass, { files: number; tokens: number }> {
  const out: any = {};
  for (const cls of ['source', 'test', 'config', 'docs', 'assets', 'generated', 'data'] as FileClass[]) {
    out[cls] = { files: 0, tokens: 0 };
  }
  for (const f of files) {
    out[f.class].files++;
    out[f.class].tokens += f.tokens;
  }
  return out;
}

export function metaSummaryLines(meta: ProjectMeta): string[] {
  const bits: string[] = [];
  if (meta.description) bits.push(meta.description);
  if (meta.languages.length) bits.push(`languages: ${meta.languages.join(', ')}`);
  if (meta.frameworks.length) bits.push(`stack: ${meta.frameworks.join(', ')}`);
  if (meta.packageManager) bits.push(`pkg mgr: ${meta.packageManager}`);
  if (meta.workspaces.length) bits.push(`workspaces: ${meta.workspaces.length}`);
  return bits;
}

export function engineStatsOf(_r: EngineResult): void {
  /* reserved for future streaming stats; keeps import surface stable */
}
