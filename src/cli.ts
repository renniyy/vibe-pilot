#!/usr/bin/env node
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runEngine } from './core/engine.js';
import { buildContext } from './core/context.js';
import { renderJson, renderScanReport } from './core/report.js';
import { PROFILES, type ProfileName } from './core/types.js';

const VERSION = '0.1.4';

const program = new Command();

program
  .name('vibe-pilot')
  .description('Context optimizer for AI engineers — prune, focus, and brief your codebase before feeding it to an AI agent.')
  .version(VERSION);

function parseProfile(value: string): ProfileName {
  if (!(value in PROFILES)) {
    throw new Error(`unknown profile "${value}" (expected: conservative | balanced | aggressive)`);
  }
  return value as ProfileName;
}

program
  .command('scan')
  .description('scan a repository and print a token/cost report (read-only)')
  .argument('[root]', 'path to the repository (default: cwd)', '.')
  .option('--json', 'machine-readable JSON report')
  .option('-p, --profile <profile>', 'pruning profile: conservative | balanced | aggressive', 'balanced')
  .option('--hot-days <days>', 'hotspot window in days', parseIntArg)
  .action(async (root: string, opts: { json?: boolean; profile: string; hotDays?: number }) => {
    const r = runEngine(root, {
      profile: parseProfile(opts.profile),
      hotDays: opts.hotDays,
    });
    if (opts.json) {
      process.stdout.write(renderJson(r) + '\n');
    } else {
      process.stdout.write(renderScanReport(r));
    }
  });

program
  .command('focus')
  .description('rank files around a topic (matches + 1-hop import neighbors)')
  .argument('<query...>', 'focus terms, e.g. "scanner gitignore"')
  .option('--root <path>', 'path to the repository', '.')
  .option('--json', 'machine-readable JSON')
  .option('-p, --profile <profile>', 'pruning profile', 'balanced')
  .option('--limit <n>', 'max results', parseIntArg, 25)
  .action(async (query: string[], opts: { root: string; json?: boolean; profile: string; limit: number }) => {
    const r = runEngine(opts.root, { profile: parseProfile(opts.profile), focus: query });
    if (opts.json) {
      process.stdout.write(renderJson(r) + '\n');
    } else {
      const { rankByFocus } = await import('./core/hot.js');
      const ranked = rankByFocus(r.focus!, opts.limit);
      process.stdout.write(`\n  focus: ${query.join(' ')} — ${ranked.length} files\n\n`);
      for (const { path: p, score } of ranked) {
        process.stdout.write(`  ${score === 100 ? '✦✦' : '✦ '} ${p}\n`);
      }
      process.stdout.write('\n');
    }
  });

program
  .command('context')
  .description('generate the .context/ briefing package for AI agents')
  .argument('[root]', 'path to the repository', '.')
  .option('--json', 'machine-readable JSON summary')
  .option('-p, --profile <profile>', 'pruning profile', 'balanced')
  .option('--focus <query>', 'focus terms to boost in the brief')
  .option('--hot-days <days>', 'hotspot window in days', parseIntArg)
  .option('--no-write', 'analyze without writing .context/ to disk')
  .option('--out <dir>', 'output directory (default: <root>/.context)')
  .action(async (root: string, opts: any) => {
    const focus = opts.focus ? String(opts.focus).split(/\s+/).filter(Boolean) : undefined;
    const r = runEngine(root, {
      profile: parseProfile(opts.profile),
      hotDays: opts.hotDays,
      focus,
    });
    const pkg = buildContext(r, { write: opts.write, outDir: opts.out });
    if (opts.json) {
      process.stdout.write(renderJson(r, pkg) + '\n');
    } else {
      process.stdout.write(renderScanReport(r, pkg));
    }
  });

program
  .command('init')
  .description('write a vibe-pilot.config.json with default settings and add .context/ to .gitignore')
  .argument('[root]', 'path to the repository', '.')
  .action((root: string) => {
    const absRoot = path.resolve(root);
    const config = {
      profile: 'balanced',
      hotDays: 30,
      focus: null as string | null,
      $schema: 'https://raw.githubusercontent.com/renniyy/vibe-pilot/main/docs/config.schema.json',
    };
    const cfgPath = path.join(absRoot, 'vibe-pilot.config.json');
    if (fs.existsSync(cfgPath)) {
      process.stdout.write(`  vibe-pilot.config.json already exists — left untouched.\n`);
      return;
    }
    fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');
    const giPath = path.join(absRoot, '.gitignore');
    if (fs.existsSync(giPath)) {
      const gi = fs.readFileSync(giPath, 'utf8');
      if (!/(^|\n)\.context\//.test(gi)) {
        fs.appendFileSync(giPath, `\n# vibe-pilot AI context brief (regenerated, do not commit)\n.context/\n`);
      }
    }
    process.stdout.write(`  ✓ wrote ${cfgPath}\n  ✓ .context/ added to .gitignore\n\n  run "vibe-pilot context" to generate your first brief.\n`);
  });

program
  .command('mcp')
  .description('start the vibe-pilot MCP server (stdio transport)')
  .action(async () => {
    const { startMcpServer } = await import('./mcp.js');
    await startMcpServer();
  });

function parseIntArg(value: string, _dummy?: unknown): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`expected a number, got "${value}"`);
  return n;
}

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`vibe-pilot: ${err.message}\n`);
  process.exitCode = 1;
});
