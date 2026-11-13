import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isBoilerplateDir,
  isGeneratedFile,
  isIgnored,
  parseGitignore,
  type IgnoreRule
} from './ignore.js';
import { estimateTokensFromBytes } from './tokens.js';
import type { FileClass, Profile, ScanResult, SkippedFile, FileInfo } from './types.js';

/** Extensions that we treat as text and are willing to describe. */
const SOURCE_EXTS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cc', 'hh', 'cs', 'php', 'pl', 'lua', 'r',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'sql', 'graphql', 'gql', 'proto', 'vue', 'svelte', 'astro',
  'sol', 'jl', 'dart', 'ex', 'exs', 'erl', 'hs', 'clj', 'cljs', 'elm',
]);
const CONFIG_EXTS = new Set([
  'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties',
  'xml', 'plist', 'editorconfig', 'gitignore', 'dockerignore', 'env',
  'lock', 'nix', 'tf', 'tfvars', 'hcl',
]);
const DOCS_EXTS = new Set(['md', 'mdx', 'rst', 'adoc', 'txt', 'org', 'tex', 'creole']);
const DATA_EXTS = new Set(['csv', 'tsv', 'jsonl', 'ndjson', 'nd', 'parquet', 'db', 'sqlite', 'sqlite3', 'pkl', 'pickle']);
const ASSET_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'wav', 'ogg', 'flac', 'aiff',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'psd', 'ai', 'sketch', 'fig', 'blend', 'glb', 'gltf', 'obj', 'stl',
]);
const CONFIG_BASENAMES = new Set([
  'makefile', 'dockerfile', 'procfile', 'jenkinsfile', 'vagrantfile',
  'cmakelists.txt', 'gemfile', 'rakefile', 'justfile', 'taskfile.yml',
]);
const TEST_HINTS = [
  /(^|\/)(tests?|__tests__|__mocks__|__snapshots__|spec|e2e|cypress)(\/|$)/i,
  /\.(test|spec|bench|stories)\.[a-z]+$/i,
  /(^|\/)(test|spec)_/i,
  /(^|\/)[a-z0-9_.-]+_(test|spec|suite)\.[a-z]+$/i,
  /(^|\/)conftest\.py$/i,
];

/** Classify a single file path into one of the seven classes. */
export function classifyFile(relPath: string): FileClass {
  const base = path.basename(relPath).toLowerCase();
  const ext = base.includes('.') ? base.split('.').pop()! : '';

  if (isGeneratedFile(base)) return 'generated';
  if (TEST_HINTS.some((re) => re.test(relPath.toLowerCase()))) return 'test';
  if (CONFIG_BASENAMES.has(base)) return 'config';
  if (CONFIG_EXTS.has(ext)) return 'config';
  if (DOCS_EXTS.has(ext)) return 'docs';
  if (SOURCE_EXTS.has(ext)) return 'source';
  if (ASSET_EXTS.has(ext)) return 'assets';
  if (DATA_EXTS.has(ext)) return 'data';

  if (/^(licen[cs]es?|copying|notice|authors|contributors|code_of_conduct|security|changelog)/i.test(base)) {
    return 'docs';
  }
  // dotfiles at any depth (e.g. .github/labeler.yml handled above by ext)
  if (base.startsWith('.') && !CONFIG_EXTS.has(ext) && !DOCS_EXTS.has(ext)) return 'config';
  return 'data';
}

function walkDir(
  absDir: string,
  relDir: string,
  ruleStack: IgnoreRule[][],
  ctx: {
    files: FileInfo[];
    skipped: SkippedFile[];
    ruleCount: number;
    boilerplateHits: Set<string>;
    profile: Profile;
  }
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));

  const localRules: IgnoreRule[] = [];
  for (const gitignoreName of ['.gitignore', '.ignore']) {
    const giPath = path.join(absDir, gitignoreName);
    if (fs.existsSync(giPath)) {
      try {
        localRules.push(...parseGitignore(fs.readFileSync(giPath, 'utf8'), path.posix.join(relDir, gitignoreName)));
        ctx.ruleCount++;
      } catch {
        /* unreadable ignore file: keep walking */
      }
    }
  }
  const stack = localRules.length ? [...ruleStack, localRules] : ruleStack;

  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.name === '.git' && entry.isDirectory()) continue; // never walk git internals
    if (isIgnored(rel, entry.isDirectory(), stack)) continue;
    if (entry.isDirectory()) {
      if (isBoilerplateDir(rel, true)) {
        ctx.boilerplateHits.add(rel);
        continue;
      }
      walkDir(path.join(absDir, entry.name), rel, stack, ctx);
    } else if (entry.isFile()) {
      if (isBoilerplateDir(rel, false)) {
        ctx.boilerplateHits.add(rel);
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(path.join(absDir, entry.name)).size;
      } catch {
        continue;
      }
      const cls = classifyFile(rel);
      const oversize = size > ctx.profile.maxFileBytes;
      ctx.files.push({
        path: rel,
        size,
        class: cls,
        oversize,
        tokens: estimateTokensFromBytes(size, cls),
      });
      if (oversize) ctx.skipped.push({ path: rel, size, reason: 'oversize' });
    }
  }
}

/**
 * Scan a repository: walk the tree honoring .gitignore files and built-in
 * boilerplate rules, classify every file, and estimate raw token cost.
 */
export function scanRepo(root: string, profile: Profile): ScanResult {
  const started = performance.now();
  const absRoot = path.resolve(root);
  const ctx = {
    files: [] as FileInfo[],
    skipped: [] as SkippedFile[],
    ruleCount: 0,
    boilerplateHits: new Set<string>(),
    profile,
  };
  walkDir(absRoot, '', [], ctx);
  return {
    root: absRoot,
    files: ctx.files,
    skipped: ctx.skipped,
    gitignoreRules: ctx.ruleCount,
    boilerplateHits: ctx.boilerplateHits.size,
    ms: Math.round(performance.now() - started),
  };
}

// gitignore-aware traversal, 7 classes, oversize guard
