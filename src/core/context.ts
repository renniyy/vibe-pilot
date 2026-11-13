import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classesBreakdown } from './meta.js';
import { estimateTokens } from './tokens.js';
import type { EngineResult, FileInfo, Profile } from './types.js';
import { PROFILES } from './types.js';

export interface ContextArtifact {
  name: string;
  content: string;
  bytes: number;
  tokens: number;
}

export interface ContextPackage {
  dir: string;
  artifacts: ContextArtifact[];
  totalTokens: number;
  written: boolean;
  treeLines: number;
  filesRows: number;
}

const PKG_VERSION = '0.1.4';

/* ------------------------------------------------------------------ */
/* file tiers                                                          */
/* ------------------------------------------------------------------ */

export function tierOf(f: FileInfo, r: EngineResult): 1 | 2 | 3 | 4 | 5 {
  if (r.graph.entries.includes(f.path)) return 1;
  if (r.hot.hot.has(f.path)) return 1;
  if (r.focus && (r.focus.scores.get(f.path) ?? 0) > 0) return 1;
  if (f.class === 'test') return 3;
  if (f.class === 'source') return 2;
  if (f.class === 'config') return 4;
  if (f.class === 'docs' && !f.path.includes('/')) return 4;
  return 5;
}

/* ------------------------------------------------------------------ */
/* tree.txt                                                            */
/* ------------------------------------------------------------------ */

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
  return `${n}B`;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
  file?: FileInfo;
  dirTokens: number;
  dirFiles: number;
}

function buildTree(files: FileInfo[]): TreeNode {
  const root: TreeNode = { name: '.', path: '', isDir: true, children: new Map(), dirTokens: 0, dirFiles: 0 };
  for (const f of files) {
    let node = root;
    const parts = f.path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1;
      const seg = parts[i];
      let child = node.children.get(seg);
      if (!child) {
        child = {
          name: seg,
          path: parts.slice(0, i + 1).join('/'),
          isDir: !isLeaf,
          children: new Map(),
          dirTokens: 0,
          dirFiles: 0,
        };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.file = f;
  }
  // roll up directory stats
  const roll = (n: TreeNode): { tokens: number; files: number } => {
    if (!n.isDir) return { tokens: n.file?.tokens ?? 0, files: 1 };
    let tokens = 0;
    let files = 0;
    for (const c of n.children.values()) {
      const sub = roll(c);
      tokens += sub.tokens;
      files += sub.files;
    }
    n.dirTokens = tokens;
    n.dirFiles = files;
    return { tokens, files };
  };
  roll(root);
  return root;
}

function renderTree(
  node: TreeNode,
  r: EngineResult,
  budget: { lines: number },
  indent: string,
  out: string[]
): void {
  const children = [...node.children.values()].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // dirs first
    if (a.isDir && b.isDir) return b.dirTokens - a.dirTokens;
    return (b.file?.tokens ?? 0) - (a.file?.tokens ?? 0);
  });

  for (const child of children) {
    if (budget.lines <= 0) {
      const remaining = countSubtree(child);
      out.push(`${indent}… +${remaining} more (collapsed)`);
      budget.lines = 0;
      return;
    }
    budget.lines--;

    if (child.isDir) {
      out.push(
        `${indent}↳ ${child.name}/  ·${child.dirFiles} files ·~${fmtTokens(child.dirTokens)} tok`
      );
      renderTree(child, r, budget, `${indent}  `, out);
    } else {
      const marks: string[] = [];
      if (r.hot.hot.has(child.path)) marks.push('▲');
      if (r.focus && (r.focus.scores.get(child.path) ?? 0) >= 50) marks.push('✦');
      if (r.graph.cold.includes(child.path)) marks.push('~');
      const mark = marks.length ? ` ${marks.join(' ')}` : '';
      const size = fmtBytes(child.file?.size ?? 0);
      out.push(
        `${indent}↳ ${child.name}${' '.repeat(Math.max(1, 34 - child.name.length))}${mark.padEnd(4)} ${size.padStart(7)} ${fmtTokens(child.file?.tokens ?? 0).padStart(6)} tok`
      );
    }
  }
}

function countSubtree(n: TreeNode): number {
  if (!n.isDir) return 1;
  let c = 0;
  for (const child of n.children.values()) c += countSubtree(child);
  return c;
}

/* ------------------------------------------------------------------ */
/* files.json                                                          */
/* ------------------------------------------------------------------ */

function buildFilesJson(r: EngineResult, maxRows: number): string {
  const rows: Record<string, unknown>[] = [];
  const sorted = [...r.scan.files].sort((a, b) => tierOf(a, r) - tierOf(b, r) || b.tokens - a.tokens);
  let truncated = 0;
  for (const f of sorted) {
    if (rows.length >= maxRows) { truncated++; continue; }
    const imports = r.graph.imports.get(f.path)?.length ?? 0;
    const importedBy = r.graph.importedBy.get(f.path)?.length ?? 0;
    rows.push({
      p: f.path,
      c: f.class,
      t: f.tokens,
      tier: tierOf(f, r),
      h: r.hot.commits.get(f.path) ?? 0,
      ...(r.focus && (r.focus.scores.get(f.path) ?? 0) > 0 ? { f: r.focus.scores.get(f.path) } : {}),
      ...(r.graph.cold.includes(f.path) ? { cold: true } : {}),
      i: imports,
      e: importedBy,
    });
  }
  // compact JSON: this file is consumed by machines, tokens matter
  return JSON.stringify({
    $schema: 'vibe-pilot/files-index@1',
    note: 'tier 1 = entry/hot/focus · 2 = reachable source · 3 = test · 4 = config · 5 = other',
    truncated: truncated || undefined,
    files: rows,
  });
}

/* ------------------------------------------------------------------ */
/* PROJECT.md                                                          */
/* ------------------------------------------------------------------ */

function buildProjectMd(r: EngineResult, profile: Profile): string {
  const L: string[] = [];
  const meta = r.meta;
  const by = classesBreakdown(r.scan.files);

  L.push(`# ${meta.name} — AI context brief`);
  L.push('');
  L.push(`> Generated by vibe-pilot v${PKG_VERSION} · profile: ${r.profile} · ${new Date().toISOString().slice(0, 10)}`);
  L.push('');

  L.push('## What this project is');
  L.push('');
  if (meta.description) L.push(`- ${meta.description}`);
  if (meta.languages.length) L.push(`- Languages: ${meta.languages.join(', ')}`);
  if (meta.frameworks.length) L.push(`- Stack: ${meta.frameworks.join(', ')}`);
  if (meta.packageManager) L.push(`- Package manager: ${meta.packageManager}`);
  if (meta.license) L.push(`- License: ${meta.license}`);
  if (Object.keys(meta.scripts).length) {
    L.push(`- Key scripts: ${Object.keys(meta.scripts).slice(0, 8).map((s) => `\`npm run ${s}\``).join(', ')}`);
  }
  if (meta.workspaces.length) {
    L.push(`- Monorepo with ${meta.workspaces.length} workspace packages: ${meta.workspaces.slice(0, 12).join(', ')}${meta.workspaces.length > 12 ? ', …' : ''}`);
  }
  L.push('');

  L.push('## Entry points');
  L.push('');
  const entries = r.graph.entries.slice(0, 12);
  if (entries.length) {
    for (const e of entries) {
      const f = r.scan.files.find((x) => x.path === e);
      L.push(`- \`${e}\`${f ? ` — ${fmtTokens(f.tokens)} tok` : ''}`);
    }
  } else {
    L.push('- No entry points detected; treat all source files as roots.');
  }
  L.push('');

  L.push(`## Hot files (last ${r.hot.hotDays} days)`);
  L.push('');
  const hotFiles = [...r.hot.commits.entries()]
    .filter(([p]) => r.scan.files.some((f) => f.path === p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  if (hotFiles.length) {
    for (const [p, c] of hotFiles) L.push(`- \`${p}\` — ${c} commit${c > 1 ? 's' : ''}`);
  } else {
    L.push(`- No commits in the last ${r.hot.hotDays} days (or not a git repo).`);
  }
  L.push('');

  if (r.focus && r.focus.matched.length) {
    L.push(`## Focus area: ${r.focus.terms.join(' ')}`);
    L.push('');
    const ranked = [...r.focus.scores.entries()]
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    for (const [p, s] of ranked) L.push(`- ${s === 100 ? '**' : ''}\`${p}\`${s === 100 ? '**' : ''} — relevance ${s}`);
    L.push('');
  }

  if (r.graph.cold.length) {
    L.push('## Dead-code candidates (unreachable from entries)');
    L.push('');
    L.push(`- ${r.graph.cold.length} source files are not reachable from any entry point (marked \`~\` in the tree). Examples:`);
    for (const c of r.graph.cold.slice(0, 10)) L.push(`  - \`${c}\``);
    L.push('');
  }

  L.push('## Code map');
  L.push('');
  L.push('```');
  const budget = { lines: 120 };
  const tree: string[] = [];
  renderTree(buildTree(r.scan.files.filter((f) => profile.classes.includes(f.class) && !f.oversize)), r, budget, '', tree);
  L.push(...tree);
  L.push('```');
  L.push('');
  L.push('Legend: `▲` hot file · `✦` focus match (incl. 1-hop neighbors) · `~` cold (unreachable).');
  L.push('');

  L.push('## Stats');
  L.push('');
  L.push('| class | files | est. tokens |');
  L.push('| --- | ---: | ---: |');
  for (const cls of ['source', 'test', 'config', 'docs', 'assets', 'generated', 'data'] as const) {
    if (by[cls].files) L.push(`| ${cls} | ${by[cls].files} | ${by[cls].tokens} |`);
  }
  L.push('');
  L.push(`- Scanned ${r.scan.files.length} files in ${r.scan.ms}ms (${r.graph.edgeCount} import edges).`);
  L.push(`- Full tree: \`tree.txt\` · machine index: \`files.json\` · manifest: \`manifest.json\``);
  L.push('');
  return L.join('\n');
}

/* ------------------------------------------------------------------ */
/* package assembly                                                    */
/* ------------------------------------------------------------------ */

export function buildContext(
  r: EngineResult,
  opts: { write?: boolean; outDir?: string } = {}
): ContextPackage {
  const profile = PROFILES[r.profile];
  const included = r.scan.files.filter(
    (f) => profile.classes.includes(f.class) && !f.oversize
  );

  const projectMd = buildProjectMd(r, profile);
  const tree = buildTree(included);

  // Fit the package under the profile's token budget: shrink the tree and the
  // file index step by step (lowest-value artifacts first) until it fits.
  let maxLines = profile.treeMaxLines;
  let maxRows = profile.filesMaxRows;
  let treeTxt = '';
  let filesJson = '';
  let treeLineCount = 0;
  for (let attempt = 0; attempt < 14; attempt++) {
    const treeLines: string[] = [];
    renderTree(tree, r, { lines: maxLines }, '', treeLines);
    treeLineCount = treeLines.length;
    treeTxt = [
      `# vibe-pilot pruned tree · ${r.meta.name} · profile: ${r.profile}`,
      '# ▲ hot · ✦ focus · ~ cold (dead-code candidate)',
      '',
    ].join('\n') + treeLines.join('\n') + '\n';
    filesJson = buildFilesJson(r, maxRows);
    const total = estimateTokens(projectMd) + estimateTokens(treeTxt) + estimateTokens(filesJson) + 400;
    if (total <= profile.tokenBudget) break;
    if (maxRows > 300) { maxRows = Math.max(300, Math.floor(maxRows * 0.8)); continue; }
    if (maxLines > 300) { maxLines = Math.max(300, Math.floor(maxLines * 0.8)); continue; }
    break; // floor reached: ship the best fit we have
  }

  const briefTokens = estimateTokens(projectMd) + estimateTokens(treeTxt) + estimateTokens(filesJson);

  const manifest = {
    generator: 'vibe-pilot',
    version: PKG_VERSION,
    profile: r.profile,
    createdAt: new Date().toISOString(),
    root: r.root,
    focus: r.focus?.terms ?? null,
    hotDays: r.hot.hotDays,
    stats: {
      rawFiles: r.scan.files.length,
      rawTokens: r.stats.rawTokens,
      briefTokens,
      reductionPct: r.stats.rawTokens
        ? Math.round((1 - briefTokens / r.stats.rawTokens) * 1000) / 10
        : 0,
      entries: r.graph.entries.length,
      coldFiles: r.graph.cold.length,
      hotFiles: r.stats.hotFiles,
      edges: r.graph.edgeCount,
      scanMs: r.scan.ms,
    },
  };
  const manifestJson = JSON.stringify(manifest, null, 2);

  const artifacts: ContextArtifact[] = [
    { name: 'PROJECT.md', content: projectMd, bytes: Buffer.byteLength(projectMd), tokens: estimateTokens(projectMd) },
    { name: 'tree.txt', content: treeTxt, bytes: Buffer.byteLength(treeTxt), tokens: estimateTokens(treeTxt) },
    { name: 'files.json', content: filesJson, bytes: Buffer.byteLength(filesJson), tokens: estimateTokens(filesJson) },
    { name: 'manifest.json', content: manifestJson, bytes: Buffer.byteLength(manifestJson), tokens: estimateTokens(manifestJson) },
  ];

  // keep the engine stats consistent with what we actually ship
  r.stats.briefTokens = briefTokens;
  r.stats.reductionPct = manifest.stats.reductionPct;

  let written = false;
  let dir = '';
  if (opts.write !== false) {
    dir = opts.outDir ?? path.join(r.root, '.context');
    fs.mkdirSync(dir, { recursive: true });
    for (const a of artifacts) fs.writeFileSync(path.join(dir, a.name), a.content);
    written = true;
  }

  return {
    dir,
    artifacts,
    totalTokens: briefTokens,
    written,
    treeLines: treeLineCount,
    filesRows: Math.min(included.length, maxRows),
  };
}

