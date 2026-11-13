import { assert, describe, it, makeRepo } from './helpers.js';
import { buildGraph } from '../src/core/graph.js';
import { scanRepo } from '../src/core/scanner.js';
import { PROFILES } from '../src/core/types.js';

describe('graph: monorepo workspaces', () => {
  it('detects workspace entries and resolves @scope/workspace imports', () => {
    // regression (langfuse-style): without workspace-aware entry detection,
    // every workspace package looked like cold code.
    const repo = makeRepo({
      'package.json': JSON.stringify({
        name: 'monorepo-root',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/ui/package.json': JSON.stringify({
        name: '@demo/ui',
        main: './src/index.ts',
      }),
      'packages/ui/src/index.ts': "export { Button } from './button';\n",
      'packages/ui/src/button.ts': 'export const Button = () => null;',
      'packages/server/package.json': JSON.stringify({
        name: '@demo/server',
        main: './dist/index.js', // gitignored build -> src twin fallback
      }),
      'packages/server/src/index.ts': "import { Button } from '@demo/ui';\nexport const app = Button;\n",
    });
    const scan = scanRepo(repo, PROFILES.balanced);
    const g = buildGraph(repo, scan.files);

    assert.equal(g.workspacePackages.length, 3, 'root + 2 workspaces');
    const names = g.workspacePackages.map((w) => w.name);
    assert.deepEqual(names.sort(), ['@demo/server', '@demo/ui', 'monorepo-root']);
    assert.ok(g.entries.includes('packages/ui/src/index.ts'), `entries: ${JSON.stringify(g.entries)}`);
    assert.ok(g.entries.includes('packages/server/src/index.ts'));
    // @demo/ui import resolves inside the monorepo, not to node_modules
    assert.equal(
      g.imports.get('packages/server/src/index.ts')?.includes('packages/ui/src/index.ts'),
      true
    );
    // nothing is cold: both workspace entries are reachable roots
    assert.deepEqual(g.cold, []);
  });
});
