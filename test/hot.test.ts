import { assert, describe, it, makeRepo } from './helpers.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeHot, scoreFocus } from '../src/core/hot.js';
import { scanRepo } from '../src/core/scanner.js';
import { buildGraph } from '../src/core/graph.js';
import { PROFILES } from '../src/core/types.js';

describe('hot: git hotspots and focus scoring', () => {
  it('counts commits per file via git log (root commit included)', async () => {
    const repo = makeRepo(
      {
        'src/a.ts': 'export const a = 1;',
        'src/b.ts': 'export const b = 2;',
        'README.md': '# x',
      },
      { git: true }
    );
    // touch src/a.ts twice more with real edits (empty commits would not
    // appear in `git log --name-only`)
    for (let i = 0; i < 2; i++) {
      fs.appendFileSync(path.join(repo, 'src/a.ts'), `\n// touch ${i}`);
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-q', '-m', `t${i}`], { cwd: repo });
    }
    const hot = computeHot(repo, 30);
    assert.equal(hot.commits.get('src/a.ts'), 3, 'root commit + 2 edit commits');
    assert.equal(hot.commits.get('src/b.ts'), 1);
    assert.equal(hot.hot.has('src/a.ts'), true);
    assert.equal(hot.hot.has('src/b.ts'), false);
    assert.equal(hot.totalCommits >= 3, true);
  });

  it('focus scoring boosts 1-hop import neighbors at half weight', () => {
    const repo = makeRepo({
      'package.json': JSON.stringify({ name: 'shop', main: 'src/index.ts' }),
      'src/index.ts': "import { charge } from './payment';\nexport { charge };\n",
      'src/payment.ts': "import { StripeGateway } from './StripeGateway';\nexport const charge = () => 1;\n",
      'src/StripeGateway.ts': 'export class StripeGateway {}',
      'src/posts.ts': 'export const list = [];', // unrelated to the focus topic
    });
    const scan = scanRepo(repo, PROFILES.balanced);
    const graph = buildGraph(repo, scan.files);
    const focus = scoreFocus(scan.files, graph.imports, graph.importedBy, ['payment']);

    assert.equal(focus.scores.get('src/payment.ts'), 100, 'direct path match scores 100');
    assert.equal(focus.scores.get('src/StripeGateway.ts'), 50, 'importee neighbor inherits half');
    assert.equal(focus.scores.get('src/index.ts'), 50, 'importer neighbor inherits half');
    assert.equal(focus.scores.has('src/posts.ts'), false, 'unrelated file stays unscored');
    const ranked = [...focus.scores.entries()].sort((a, b) => b[1] - a[1]);
    assert.equal(ranked[0][0], 'src/payment.ts');
  });
});
