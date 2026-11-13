import { assert, describe, it, makeRepo } from './helpers.js';
import { buildGraph } from '../src/core/graph.js';
import { scanRepo } from '../src/core/scanner.js';
import { PROFILES } from '../src/core/types.js';

describe('graph: JS/TS import resolution and entry detection', () => {
  it('resolves relative imports, detects entries, and finds cold files', () => {
    // package.json "main" points at a gitignored dist/ build output — the
    // graph must still find the src twin (the fix that keeps package.json
    // visible to the graph by passing the FULL file list).
    const repo = makeRepo({
      'package.json': JSON.stringify({ name: 'demo-app', main: './dist/index.js', scripts: { start: 'node dist/cli.js' } }),
      'src/index.ts': `import { helper } from './util/helper';\nimport { Config } from './config';\nexport { helper, Config };\n`,
      'src/util/helper.ts': 'export const helper = () => 1;',
      'src/config.ts': 'export interface Config { a: number }',
      'src/orphan.ts': 'export const dead = 1;', // unreachable: cold
      'README.md': '# demo',
    });
    const scan = scanRepo(repo, PROFILES.balanced);
    const g = buildGraph(repo, scan.files);

    assert.ok(g.entries.includes('src/index.ts'), `entries: ${JSON.stringify(g.entries)}`);
    assert.ok(g.reachable.has('src/index.ts'));
    assert.ok(g.reachable.has('src/util/helper.ts'));
    assert.ok(g.reachable.has('src/config.ts'));
    assert.equal(g.imports.get('src/index.ts')?.includes('src/util/helper.ts'), true);
    assert.equal(g.imports.get('src/index.ts')?.includes('src/config.ts'), true);
    // orphan.ts is a source file unreachable from entries -> cold
    assert.deepEqual(g.cold, ['src/orphan.ts']);
  });

  it('resolves tsconfig path aliases and index files', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ name: 'aliased', main: 'src/index.ts' }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
      'src/index.ts': "import { thing } from '@/lib/thing';\n",
      'src/lib/thing.ts': 'export const thing = 2;',
    });
    const scan = scanRepo(repo, PROFILES.balanced);
    const g = buildGraph(repo, scan.files);
    assert.equal(g.imports.get('src/index.ts')?.includes('src/lib/thing.ts'), true);
  });
});
