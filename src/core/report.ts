import { classesBreakdown } from './meta.js';
import { rankByFocus } from './hot.js';
import type { ContextPackage } from './context.js';
import type { EngineResult } from './types.js';

/* ANSI helpers: colorize only when attached to a TTY. */
const TTY = typeof process.stdout.isTTY !== 'undefined' && process.stdout.isTTY;
const c = (code: string, s: string) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c('1', s);
const dim = (s: string) => c('2', s);
const cyan = (s: string) => c('36', s);
const green = (s: string) => c('32', s);
const yellow = (s: string) => c('33', s);
const magenta = (s: string) => c('35', s);

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function bar(pct: number, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function renderScanReport(r: EngineResult, pkg?: ContextPackage): string {
  const L: string[] = [];
  const by = classesBreakdown(r.scan.files);

  L.push('');
  L.push(`${bold(cyan('vibe-pilot'))} ${dim(`scan · ${r.meta.name} · profile ${r.profile}`)}`);
  L.push('');
  L.push(`  files         ${String(r.scan.files.length).padStart(10)}   ${dim(`(${r.scan.skipped.length} oversize skipped)`)}`);
  L.push(`  raw tokens    ${fmtTokens(r.stats.rawTokens).padStart(10)}   ${dim('what a naive agent would ingest')}`);
  if (pkg) {
    L.push(`  brief tokens  ${fmtTokens(r.stats.briefTokens).padStart(10)}   ${dim('.context package, ready to feed')}`);
    L.push(`  reduction     ${green(`−${r.stats.reductionPct}%`)}    ${dim(bar(r.stats.reductionPct))}`);
  }
  L.push(`  entries       ${String(r.stats.entries).padStart(10)}   ${dim('detected entry points')}`);
  L.push(`  import edges  ${String(r.stats.edges).padStart(10)}`);
  L.push(`  hot files     ${String(r.stats.hotFiles).padStart(10)}   ${dim(`last ${r.hot.hotDays} days`)}`);
  L.push(`  cold files    ${yellow(String(r.stats.coldFiles).padStart(10))}   ${dim('unreachable from entries')}`);
  if (r.stats.workspacePackages > 1) {
    L.push(`  workspaces    ${String(r.stats.workspacePackages).padStart(10)}`);
  }
  L.push(`  scan time     ${String(r.scan.ms).padStart(10)}ms`);
  L.push('');
  L.push(`  ${bold('breakdown by class')}`);
  const maxTok = Math.max(1, ...Object.values(by).map((v) => v.tokens));
  for (const cls of ['source', 'test', 'config', 'docs', 'assets', 'generated', 'data'] as const) {
    const v = by[cls];
    if (!v.files) continue;
    L.push(
      `    ${cls.padEnd(9)} ${String(v.files).padStart(6)}  ${fmtTokens(v.tokens).padStart(7)}  ${dim(bar((v.tokens / maxTok) * 100, 18))}`
    );
  }
  if (r.graph.cold.length) {
    L.push('');
    L.push(`  ${yellow('cold files (dead-code candidates)')}`);
    for (const cf of r.graph.cold.slice(0, 8)) L.push(`    ~ ${cf}`);
    if (r.graph.cold.length > 8) L.push(`    ${dim(`… +${r.graph.cold.length - 8} more`)}`);
  }
  if (r.focus) {
    L.push('');
    L.push(`  ${magenta(`focus: ${r.focus.terms.join(' ')}`)}`);
    for (const { path, score } of rankByFocus(r.focus, 10)) {
      L.push(`    ${score === 100 ? '✦✦' : '✦ '} ${path} ${dim(`(${score})`)}`);
    }
  }
  L.push('');
  if (pkg?.written) {
    L.push(`  ${green('✓')} wrote ${pkg.dir}/ ${dim('(PROJECT.md, tree.txt, files.json, manifest.json)')}`);
    L.push('');
  }
  return L.join('\n');
}

export function renderJson(r: EngineResult, pkg?: ContextPackage): string {
  const by = classesBreakdown(r.scan.files);
  return JSON.stringify(
    {
      generator: 'vibe-pilot',
      version: '0.1.4',
      root: r.root,
      profile: r.profile,
      meta: r.meta,
      stats: {
        ...r.stats,
        classes: by,
      },
      graph: {
        entries: r.graph.entries,
        cold: r.graph.cold,
        edges: r.graph.edgeCount,
        workspacePackages: r.graph.workspacePackages,
      },
      hot: {
        hotFiles: [...r.hot.hot].slice(0, 100),
        hotDays: r.hot.hotDays,
        totalCommits: r.hot.totalCommits,
      },
      focus: r.focus
        ? { terms: r.focus.terms, matched: r.focus.matched.slice(0, 100), top: rankByFocus(r.focus, 25) }
        : null,
      context: pkg
        ? {
            written: pkg.written,
            dir: pkg.dir || '.context',
            totalTokens: pkg.totalTokens,
            artifacts: pkg.artifacts.map((a) => ({ name: a.name, bytes: a.bytes, tokens: a.tokens })),
          }
        : null,
    },
    null,
    2
  );
}
