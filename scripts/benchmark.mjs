#!/usr/bin/env node
/**
 * vibe-pilot benchmark: shallow-clone 21 real-world repositories, scan each
 * one, and measure the raw-token -> brief-token reduction of the .context
 * package (balanced profile, nothing written into the repos).
 *
 * Usage:
 *   node scripts/benchmark.mjs            # clone missing repos + run
 *   VIBE_BENCH_ROOT=/path/to/repos node scripts/benchmark.mjs
 *
 * Output: scripts/out/benchmark.json
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEngine, buildContext } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const REPOS_ROOT = process.env.VIBE_BENCH_ROOT ?? path.join(projectRoot, 'repos');

const REPOS = [
  ['microsoft/vscode', 'vscode'],
  ['facebook/react', 'react'],
  ['vercel/next.js', 'next.js'],
  ['vuejs/core', 'core'],
  ['angular/angular', 'angular'],
  ['langfuse/langfuse', 'langfuse'],
  ['prisma/prisma', 'prisma'],
  ['vitejs/vite', 'vite'],
  ['ant-design/ant-design', 'ant-design'],
  ['tailwindlabs/tailwindcss', 'tailwindcss'],
  ['axios/axios', 'axios'],
  ['lodash/lodash', 'lodash'],
  ['expressjs/express', 'express'],
  ['electron/electron', 'electron'],
  ['huggingface/transformers', 'transformers'],
  ['langchain-ai/langchain', 'langchain'],
  ['django/django', 'django'],
  ['fastapi/fastapi', 'fastapi'],
  ['psf/requests', 'requests'],
  ['scikit-learn/scikit-learn', 'scikit-learn'],
  ['modelcontextprotocol/servers', 'servers'],
];

function ensureClone(slug, dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return false;
  console.error(` cloning ${slug} ...`);
  execFileSync(
    'git',
    ['clone', '--quiet', '--depth', '100', '--single-branch', `https://github.com/${slug}.git`, dir],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 15 * 60 * 1000 }
  );
  return true;
}

const results = [];
let cloned = 0;
for (const [slug, dirname] of REPOS) {
  const dir = path.join(REPOS_ROOT, dirname);
  try {
    if (ensureClone(slug, dir)) cloned++;
    const t0 = performance.now();
    const r = runEngine(dir, { profile: 'balanced' });
    const pkg = buildContext(r, { write: false });
    const wallMs = Math.round(performance.now() - t0);
    const row = {
      repo: slug,
      files: r.scan.files.length,
      rawTokens: r.stats.rawTokens,
      briefTokens: r.stats.briefTokens,
      reductionPct: r.stats.reductionPct,
      entries: r.stats.entries,
      coldFiles: r.stats.coldFiles,
      hotFiles: r.stats.hotFiles,
      edges: r.stats.edges,
      scanMs: r.scan.ms,
      wallMs,
    };
    results.push(row);
    console.error(
      ` ✓ ${slug.padEnd(34)} ${String(row.files).padStart(6)} files  ${String(row.rawTokens).padStart(9)} → ${String(row.briefTokens).padStart(7)} tok  (−${row.reductionPct}%)  ${row.wallMs}ms`
    );
  } catch (err) {
    console.error(` ✗ ${slug}: ${err.message}`);
    results.push({ repo: slug, error: err.message });
  }
}

const okRows = results.filter((r) => !r.error);
const summary = {
  repos: okRows.length,
  totalFiles: okRows.reduce((s, r) => s + r.files, 0),
  totalRawTokens: okRows.reduce((s, r) => s + r.rawTokens, 0),
  totalBriefTokens: okRows.reduce((s, r) => s + r.briefTokens, 0),
  reductionPct: 0,
  clonedNow: cloned,
  fastestScanMs: Math.min(...okRows.map((r) => r.scanMs)),
  slowestScanMs: Math.max(...okRows.map((r) => r.scanMs)),
  profile: 'balanced',
  date: new Date().toISOString(),
};
summary.reductionPct = summary.totalRawTokens
  ? Math.round((1 - summary.totalBriefTokens / summary.totalRawTokens) * 1000) / 10
  : 0;

const out = { summary, results };
const outDir = path.join(projectRoot, 'scripts', 'out');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'benchmark.json');
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.error('\n===== summary =====');
for (const [k, v] of Object.entries(summary)) console.error(`  ${k}: ${v}`);
console.error(`\nwrote ${outPath}`);
