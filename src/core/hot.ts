import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FileInfo, FocusResult, HotResult } from './types.js';

/** Percentile of commits-per-file above which a file is a hotspot. */
const HOT_PERCENTILE = 0.9;
const HOT_MIN_COMMITS = 2;

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
  } catch {
    return '';
  }
}

/**
 * Compute commit hotspots. Uses `git log --name-only` (correct for root
 * commits too, unlike `git diff-tree` which returns nothing for them).
 */
export function computeHot(root: string, hotDays: number): HotResult {
  const commits = new Map<string, number>();
  const lastTouch = new Map<string, string>();
  let totalCommits = 0;

  const hasGit = fs.existsSync(path.join(root, '.git'));
  if (hasGit) {
    const log = git(root, [
      'log', `--since=${hotDays} days ago`, '--name-only', '--pretty=format:%H\x1f%aI',
    ]);
    if (log) {
      let currentIso = '';
      for (const line of log.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (t.includes('\x1f')) {
          currentIso = t.split('\x1f')[1] || '';
          totalCommits++;
          continue;
        }
        if (t.includes(' -> ')) continue; // rename with old target: keep both simple
        commits.set(t, (commits.get(t) ?? 0) + 1);
        if (currentIso && !lastTouch.has(t)) lastTouch.set(t, currentIso);
      }
    }
  }

  const sorted = [...commits.values()].sort((a, b) => a - b);
  const threshold = sorted.length
    ? Math.max(HOT_MIN_COMMITS, sorted[Math.floor((sorted.length - 1) * (1 - HOT_PERCENTILE))] || HOT_MIN_COMMITS)
    : HOT_MIN_COMMITS;
  const hot = new Set<string>();
  for (const [file, count] of commits) {
    if (count >= threshold) hot.add(file);
  }

  return { commits, lastTouch, hot, hotDays, totalCommits };
}

function termsMatch(terms: string[], haystack: string): boolean {
  const lower = haystack.toLowerCase();
  return terms.some((t) => lower.includes(t.toLowerCase()));
}

/**
 * Score focus relevance: files whose path matches the focus terms get 100,
 * and their one-hop import-graph neighbors inherit half of that. Results are
 * clamped to 0..100.
 */
export function scoreFocus(
  files: FileInfo[],
  imports: Map<string, string[]>,
  importedBy: Map<string, string[]>,
  terms: string[]
): FocusResult {
  const scores = new Map<string, number>();
  const matched: string[] = [];
  if (!terms.length) return { scores, terms, matched };

  for (const f of files) {
    if (f.class !== 'source' && f.class !== 'test') continue;
    if (termsMatch(terms, f.path)) {
      scores.set(f.path, 100);
      matched.push(f.path);
    }
  }

  // one-hop neighborhood: importers and importees inherit half the weight
  for (const seed of matched) {
    for (const neighbor of [...(imports.get(seed) ?? []), ...(importedBy.get(seed) ?? [])]) {
      if (scores.has(neighbor) && scores.get(neighbor) === 100) continue;
      scores.set(neighbor, Math.min(100, Math.max(scores.get(neighbor) ?? 0, 50)));
    }
  }

  return { scores, terms, matched };
}

/** Rank files by focus score, descending. */
export function rankByFocus(focus: FocusResult, limit = 20): { path: string; score: number }[] {
  return [...focus.scores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([path, score]) => ({ path, score }));
}
