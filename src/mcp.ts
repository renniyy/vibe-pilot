import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'node:path';
import { runEngine } from './core/engine.js';
import { buildContext } from './core/context.js';
import { rankByFocus } from './core/hot.js';
import type { FileClass } from './core/types.js';

const VERSION = '0.1.4';
const MAX_RESULT_CHARS = 24_000;

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const cut = text.length - MAX_RESULT_CHARS;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated ${cut} chars — rerun with a narrower root, focus, or class filter]`;
}

function diag(msg: string): void {
  // stdout is reserved for the JSON-RPC stream: diagnostics go to stderr.
  process.stderr.write(`[vibe-pilot] ${msg}\n`);
}

function resolveRoot(input?: string): string {
  return input ? path.resolve(process.cwd(), input) : process.cwd();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text: truncate(text) }] };
}

function fail(message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: truncate(`error: ${message}`) }],
  };
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({ name: 'vibe-pilot', version: VERSION });

  server.tool(
    'vibe_pilot_scan',
    'Scan a repository and report file classes, token cost, entry points, import-graph stats, git hotspots and cold (dead-code) files. Read-only.',
    {
      root: z.string().optional().describe('Repo path (absolute or relative to the server cwd). Defaults to cwd.'),
      profile: z.enum(['conservative', 'balanced', 'aggressive']).optional().describe('Pruning profile. Default: balanced.'),
      hot_days: z.number().int().positive().optional().describe('Hotspot window in days. Default: profile value.'),
    },
    async ({ root, profile, hot_days }) => {
      try {
        const r = runEngine(resolveRoot(root), { profile, hotDays: hot_days });
        const by: Record<string, { files: number; tokens: number }> = {};
        for (const f of r.scan.files) {
          by[f.class] ??= { files: 0, tokens: 0 };
          by[f.class].files++;
          by[f.class].tokens += f.tokens;
        }
        const text = [
          `# vibe-pilot scan — ${r.meta.name} (profile: ${r.profile})`,
          '',
          `- files: ${r.scan.files.length} (raw tokens ${r.stats.rawTokens})`,
          `- entries: ${r.stats.entries} · import edges: ${r.stats.edges}`,
          `- hot files (last ${r.hot.hotDays}d): ${r.stats.hotFiles}`,
          `- cold files (unreachable from entries): ${r.stats.coldFiles}`,
          `- scan time: ${r.scan.ms}ms`,
          '',
          '## class breakdown',
          ...Object.entries(by).map(([k, v]) => `- ${k}: ${v.files} files, ~${v.tokens} tokens`),
          '',
          '## entries',
          ...(r.graph.entries.slice(0, 20).map((e) => `- ${e}`) || ['- (none detected)']),
          '',
          r.graph.cold.length ? `## cold files (top 20)\n${r.graph.cold.slice(0, 20).map((c) => `- ${c}`).join('\n')}` : '',
        ].filter(Boolean).join('\n');
        diag(`scan ok: ${r.scan.files.length} files in ${r.scan.ms}ms`);
        return ok(text);
      } catch (err) {
        diag(`scan failed: ${(err as Error).message}`);
        return fail((err as Error).message);
      }
    }
  );

  server.tool(
    'get_context',
    'Build the focused .context/ briefing package for a repository and return PROJECT.md plus key stats. Writes .context/ (PROJECT.md, tree.txt, files.json, manifest.json).',
    {
      root: z.string().optional().describe('Repo path. Defaults to cwd.'),
      profile: z.enum(['conservative', 'balanced', 'aggressive']).optional(),
      focus: z.string().optional().describe('Focus terms, e.g. "auth token refresh".'),
      hot_days: z.number().int().positive().optional(),
    },
    async ({ root, profile, focus, hot_days }) => {
      try {
        const terms = focus ? focus.split(/\s+/).filter(Boolean) : undefined;
        const r = runEngine(resolveRoot(root), { profile, focus: terms, hotDays: hot_days });
        const pkg = buildContext(r, {});
        const text = [
          `# .context package — ${r.meta.name} (profile ${r.profile})`,
          '',
          `raw ${r.stats.rawTokens} tok → brief ${r.stats.briefTokens} tok (−${r.stats.reductionPct}%) · written to ${pkg.dir}`,
          '',
          ...pkg.artifacts.filter((a) => a.name === 'PROJECT.md').map((a) => a.content),
          '',
          `--- tree.txt excerpt (${Math.min(60, pkg.treeLines)} of ${pkg.treeLines} lines) ---`,
          ...pkg.artifacts
            .find((a) => a.name === 'tree.txt')!
            .content.split('\n')
            .slice(0, 60),
        ].join('\n');
        diag(`context ok: ${r.stats.briefTokens} brief tokens (−${r.stats.reductionPct}%)`);
        return ok(text);
      } catch (err) {
        diag(`context failed: ${(err as Error).message}`);
        return fail((err as Error).message);
      }
    }
  );

  server.tool(
    'focus',
    'Rank repository files around a topic: path matches get full score, one-hop import-graph neighbors inherit half.',
    {
      root: z.string().optional().describe('Repo path. Defaults to cwd.'),
      query: z.string().describe('Topic terms, e.g. "scanner gitignore".'),
      limit: z.number().int().positive().optional().describe('Max results. Default: 25.'),
    },
    async ({ root, query, limit }) => {
      try {
        const terms = query.split(/\s+/).filter(Boolean);
        const r = runEngine(resolveRoot(root), { focus: terms });
        const ranked = rankByFocus(r.focus!, limit ?? 25);
        const text = [
          `focus: ${terms.join(' ')} — ${ranked.length} files`,
          '',
          ...ranked.map(({ path, score }) => `${score === 100 ? '✦✦' : '✦ '} ${path} (${score})`),
        ].join('\n');
        diag(`focus ok: ${ranked.length} matches for "${query}"`);
        return ok(text);
      } catch (err) {
        diag(`focus failed: ${(err as Error).message}`);
        return fail((err as Error).message);
      }
    }
  );

  server.tool(
    'list_files',
    'List repository files, optionally filtered by vibe-pilot class: source | test | config | docs | assets | generated | data.',
    {
      root: z.string().optional().describe('Repo path. Defaults to cwd.'),
      class: z.enum(['source', 'test', 'config', 'docs', 'assets', 'generated', 'data']).optional(),
      limit: z.number().int().positive().optional().describe('Max results. Default: 200.'),
    },
    async ({ root, class: fileClass, limit }) => {
      try {
        const r = runEngine(resolveRoot(root), {});
        const filtered = fileClass
          ? r.scan.files.filter((f) => f.class === (fileClass as FileClass))
          : r.scan.files;
        const cap = limit ?? 200;
        const lines = filtered
          .slice(0, cap)
          .map((f) => `- ${f.path} (${f.class}, ${f.tokens} tok${f.oversize ? ', oversize' : ''})`);
        const text = [
          `${filtered.length} files${fileClass ? ` in class "${fileClass}"` : ''}${filtered.length > cap ? ` (showing ${cap})` : ''}`,
          '',
          ...lines,
          filtered.length > cap ? `… +${filtered.length - cap} more` : '',
        ].filter(Boolean).join('\n');
        diag(`list_files ok: ${filtered.length} files`);
        return ok(text);
      } catch (err) {
        diag(`list_files failed: ${(err as Error).message}`);
        return fail((err as Error).message);
      }
    }
  );

  const transport = new StdioServerTransport();
  diag(`vibe-pilot MCP server v${VERSION} starting on stdio`);
  await server.connect(transport);
  diag('ready');
}
