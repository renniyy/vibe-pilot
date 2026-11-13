/**
 * vibe-pilot — context optimizer for AI engineers.
 *
 * Prunes boilerplate, compresses dependency trees, and generates a focused
 * `.context/` brief (PROJECT.md, tree.txt, files.json, manifest.json) that
 * you can feed to Cursor / Claude Code / Windsurf instead of the raw repo.
 */

export { scanRepo, classifyFile } from './core/scanner.js';
export {
  parseGitignore,
  isIgnored,
  isBoilerplateDir,
  BOILERPLATE_DIRS,
} from './core/ignore.js';
export { buildGraph } from './core/graph.js';
export { computeHot, scoreFocus, rankByFocus } from './core/hot.js';
export { buildContext } from './core/context.js';
export { runEngine } from './core/engine.js';
export type { RunOptions } from './core/engine.js';
export { detectMeta, classesBreakdown } from './core/meta.js';
export { estimateTokens, estimateTokensFromBytes } from './core/tokens.js';
export { renderJson, renderScanReport } from './core/report.js';
export { startMcpServer } from './mcp.js';
export {
  PROFILES,
  FILE_CLASSES,
} from './core/types.js';
export type {
  FileClass,
  ProfileName,
  Profile,
  FileInfo,
  ScanResult,
  GraphResult,
  HotResult,
  FocusResult,
  EngineStats,
  EngineResult,
  ProjectMeta,
} from './core/types.js';
export type { ContextPackage, ContextArtifact } from './core/context.js';

export const VERSION = '0.1.4';
