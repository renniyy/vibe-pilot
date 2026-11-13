/** Shared types for the vibe-pilot core engine. */

/** The seven file classes vibe-pilot sorts a repository into. */
export type FileClass =
  | 'source'
  | 'test'
  | 'config'
  | 'docs'
  | 'assets'
  | 'generated'
  | 'data';

export const FILE_CLASSES: FileClass[] = [
  'source',
  'test',
  'config',
  'docs',
  'assets',
  'generated',
  'data',
];

export type ProfileName = 'conservative' | 'balanced' | 'aggressive';

export interface Profile {
  /** Files above this size are flagged oversize and kept out of the brief. */
  maxFileBytes: number;
  /** Which file classes are allowed into the .context brief. */
  classes: FileClass[];
  /** Hotspot window in days. */
  hotDays: number;
  /** Soft token budget for the whole .context package. */
  tokenBudget: number;
  /** Max lines in tree.txt before deep directories collapse. */
  treeMaxLines: number;
  /** Max rows in files.json before overflow is truncated. */
  filesMaxRows: number;
}

export const PROFILES: Record<ProfileName, Profile> = {
  conservative: {
    maxFileBytes: 1024 * 1024,
    classes: ['source', 'test', 'config', 'docs', 'assets', 'data'],
    hotDays: 60,
    tokenBudget: 150_000,
    treeMaxLines: 6000,
    filesMaxRows: 4000,
  },
  balanced: {
    maxFileBytes: 512 * 1024,
    classes: ['source', 'test', 'config', 'data'],
    hotDays: 30,
    tokenBudget: 60_000,
    treeMaxLines: 3500,
    filesMaxRows: 2000,
  },
  aggressive: {
    maxFileBytes: 256 * 1024,
    classes: ['source', 'test'],
    hotDays: 14,
    tokenBudget: 25_000,
    treeMaxLines: 1500,
    filesMaxRows: 800,
  },
};

export interface FileInfo {
  /** Path relative to repo root, posix separators. */
  path: string;
  /** File size in bytes. */
  size: number;
  /** Classification. */
  class: FileClass;
  /** True when size > profile.maxFileBytes. */
  oversize: boolean;
  /** Estimated tokens for the raw file. */
  tokens: number;
}

export interface SkippedFile {
  path: string;
  size: number;
  reason: 'oversize' | 'binary';
}

export interface ScanResult {
  root: string;
  files: FileInfo[];
  skipped: SkippedFile[];
  /** Number of gitignore rule lines parsed. */
  gitignoreRules: number;
  /** Number of built-in boilerplate rules that fired. */
  boilerplateHits: number;
  ms: number;
}

export interface GraphResult {
  /** Repo-relative path -> resolved repo-relative import targets. */
  imports: Map<string, string[]>;
  /** Repo-relative path -> importers. */
  importedBy: Map<string, string[]>;
  /** Entry-point files detected. */
  entries: string[];
  /** Source files reachable from entries (transitively). */
  reachable: Set<string>;
  /** Source files unreachable from any entry (dead-code candidates). */
  cold: string[];
  edgeCount: number;
  workspacePackages: { name: string; dir: string; entry: string | null }[];
}

export interface HotResult {
  /** Commits per repo-relative path within the window. */
  commits: Map<string, number>;
  /** Last commit timestamp (ISO) per path, when available. */
  lastTouch: Map<string, string>;
  /** Paths that qualify as hotspots. */
  hot: Set<string>;
  hotDays: number;
  totalCommits: number;
}

export interface FocusResult {
  /** Repo-relative path -> 0..100 relevance score. */
  scores: Map<string, number>;
  terms: string[];
  matched: string[];
}

export interface EngineStats {
  rawTokens: number;
  rawFiles: number;
  briefTokens: number;
  reductionPct: number;
  entries: number;
  coldFiles: number;
  hotFiles: number;
  edges: number;
  workspacePackages: number;
  scanMs: number;
  totalMs: number;
}

export interface EngineResult {
  root: string;
  profile: ProfileName;
  scan: ScanResult;
  graph: GraphResult;
  hot: HotResult;
  focus: FocusResult | null;
  meta: ProjectMeta;
  stats: EngineStats;
}

export interface ProjectMeta {
  name: string;
  description: string;
  languages: string[];
  frameworks: string[];
  packageManager: string | null;
  python: boolean;
  license: string | null;
  scripts: Record<string, string>;
  workspaces: string[];
  tsconfigPaths: boolean;
}
