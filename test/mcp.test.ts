import { assert, describe, it, makeRepo } from './helpers.js';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(here, '../src/cli.js');
const SERVER_ARGS = ['mcp'];

interface RpcResponse {
  jsonrpc: string;
  id?: number | string;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/** Drive the MCP stdio server with newline-delimited JSON-RPC. */
async function rpcSession(messages: unknown[], cwd: string): Promise<Map<number | string, RpcResponse>> {
  const child = spawn(process.execPath, [SERVER, ...SERVER_ARGS], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const responses = new Map<number | string, RpcResponse>();
  const pending = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('rpc session timed out')), 30_000);
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg: RpcResponse = JSON.parse(line);
          if (msg.id !== undefined) responses.set(msg.id, msg);
        } catch {
          /* ignore non-JSON noise */
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => { /* diagnostics channel */ });
    const finish = () => { clearTimeout(timer); resolve(); };
    child.on('exit', finish);
    // resolve once all expected ids arrived
    const check = setInterval(() => {
      if (responses.size >= messages.filter((m: any) => m.id !== undefined).length) {
        clearInterval(check);
        clearTimeout(timer);
        child.kill();
        resolve();
      }
    }, 50);
    setTimeout(() => { clearInterval(check); }, 29_000).unref?.();
  });

  for (const msg of messages) child.stdin.write(`${JSON.stringify(msg)}\n`);
  await pending;
  child.kill();
  return responses;
}

describe('mcp: stdio JSON-RPC handshake (end-to-end)', () => {
  it('initializes, lists the 4 tools, and answers a scan + focus call', async () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ name: 'rpc-fixture', main: 'src/index.ts' }),
      'src/index.ts': "import { ping } from './ping';\nexport const run = ping;\n",
      'src/ping.ts': 'export const ping = () => 1;',
      'src/legacy.ts': 'export const old = 1;',
    });

    const responses = await rpcSession(
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0.0.0' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vibe_pilot_scan', arguments: { root: repo } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'focus', arguments: { root: repo, query: 'ping' } } },
      ],
      repo
    );

    const init = responses.get(1);
    assert.ok(init?.result, 'initialize returned a result');
    assert.equal(init!.result.serverInfo.name, 'vibe-pilot');
    assert.ok(init!.result.serverInfo.version.length > 0);

    const tools = responses.get(2);
    const names = (tools?.result?.tools ?? []).map((t: any) => t.name).sort();
    assert.deepEqual(names, ['focus', 'get_context', 'list_files', 'vibe_pilot_scan']);

    const scan = responses.get(3);
    assert.ok(scan?.result?.content?.[0]?.type === 'text', 'scan call returned text');
    const scanText = scan!.result.content[0].text as string;
    assert.match(scanText, /rpc-fixture/);
    assert.match(scanText, /cold files/);

    const focus = responses.get(4);
    const focusText = focus?.result?.content?.[0]?.text as string;
    assert.match(focusText ?? '', /src\/ping\.ts/);
  });
});
