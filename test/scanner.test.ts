import { assert, describe, it, makeRepo } from './helpers.js';
import { classifyFile } from '../src/core/scanner.js';
import { scanRepo } from '../src/core/scanner.js';
import { PROFILES } from '../src/core/types.js';

describe('scanner: 7-class classification', () => {
  it('classifies by extension and path hints', () => {
    assert.equal(classifyFile('src/index.ts'), 'source');
    assert.equal(classifyFile('src/index.test.ts'), 'test');
    assert.equal(new Set(['source']).has(classifyFile('app/Widget.tsx')), true);
    assert.equal(classifyFile('pkg/__tests__/a.ts'), 'test');
    assert.equal(classifyFile('tests/test_foo.py'), 'test');
    assert.equal(classifyFile('conftest.py'), 'test');
    assert.equal(classifyFile('tsconfig.json'), 'config');
    assert.equal(classifyFile('.github/workflows/ci.yml'), 'config');
    assert.equal(classifyFile('README.md'), 'docs');
    assert.equal(classifyFile('docs/guide.md'), 'docs');
    assert.equal(classifyFile('logo.png'), 'assets');
    assert.equal(classifyFile('package-lock.json'), 'generated');
    assert.equal(classifyFile('app.min.js'), 'generated');
    assert.equal(classifyFile('data/seed.csv'), 'data');
    assert.equal(classifyFile('Dockerfile'), 'config');
  });
});

describe('scanner: gitignore awareness + oversize guard', () => {
  it('respects .gitignore files and flags oversize files', () => {
    const repo = makeRepo({
      '.gitignore': 'build/\nsecret.env\n*.log\n',
      'src/a.ts': 'export const a = 1;',
      'build/out.js': 'module.exports = 1;',
      'secret.env': 'A=1',
      'debug.log': 'x',
      'big.bin': 'x'.repeat(600 * 1024),
    });
    const scan = scanRepo(repo, PROFILES.balanced);
    const paths = scan.files.map((f) => f.path);
    assert.ok(paths.includes('src/a.ts'));
    assert.ok(!paths.includes('build/out.js'));
    assert.ok(!paths.includes('secret.env'));
    assert.ok(!paths.includes('debug.log'));
    const big = scan.files.find((f) => f.path === 'big.bin');
    assert.ok(big, 'oversize file still listed');
    assert.equal(big!.oversize, true);
    assert.equal(scan.skipped[0].reason, 'oversize');
    assert.equal(scan.gitignoreRules, 1);
  });
});
