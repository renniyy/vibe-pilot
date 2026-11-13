import * as path from 'node:path';
import { buildGraph } from './graph.js';
import { computeHot, scoreFocus } from './hot.js';
import { detectMeta } from './meta.js';
import { scanRepo } from './scanner.js';
import { PROFILES, type EngineResult, type ProfileName } from './types.js';

export interface RunOptions {
  profile?: ProfileName;
  /** Focus terms: files matching these (and 1-hop neighbors) get ranked. */
  focus?: string[];
  /** Override the profile's hotspot window. */
  hotDays?: number;
}

/**
 * Run the full pipeline: scan -> import graph -> git hotspots -> focus ->
 * metadata. The graph builder receives the complete file list so
 * package.json / tsconfig stay visible for entry detection.
 */
export function runEngine(root: string, opts: RunOptions = {}): EngineResult {
  const profileName: ProfileName = opts.profile ?? 'balanced';
  const profile = PROFILES[profileName];
  const absRoot = path.resolve(root);

  const t0 = performance.now();
  const scan = scanRepo(absRoot, profile);
  const graph = buildGraph(absRoot, scan.files);
  const hot = computeHot(absRoot, opts.hotDays ?? profile.hotDays);
  const focus = opts.focus?.length ? scoreFocus(scan.files, graph.imports, graph.importedBy, opts.focus) : null;
  const meta = detectMeta(absRoot, scan.files, graph.workspacePackages);

  const rawTokens = scan.files.reduce((sum, f) => sum + f.tokens, 0);
  const stats = {
    rawTokens,
    rawFiles: scan.files.length,
    briefTokens: 0,
    reductionPct: 0,
    entries: graph.entries.length,
    coldFiles: graph.cold.length,
    hotFiles: hot.hot.size,
    edges: graph.edgeCount,
    workspacePackages: graph.workspacePackages.length,
    scanMs: scan.ms,
    totalMs: 0,
  };

  return {
    root: absRoot,
    profile: profileName,
    scan,
    graph,
    hot,
    focus,
    meta,
    stats: {
      ...stats,
      totalMs: Math.round(performance.now() - t0),
    },
  };
}
