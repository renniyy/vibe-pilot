import { assert, describe, it } from './helpers.js';
import {
  isBoilerplateDir,
  isGeneratedFile,
  parseGitignore,
  isIgnored,
} from '../src/core/ignore.js';

describe('ignore: built-in boilerplate rules', () => {
  it('flags boilerplate directories and generated files', () => {
    assert.equal(isBoilerplateDir('node_modules/react/index.js', false), true);
    assert.equal(isBoilerplateDir('dist/index.js', false), true);
    assert.equal(isBoilerplateDir('__pycache__/mod.pyc', false), true);
    assert.equal(isBoilerplateDir('.git/config', false), true);
    assert.equal(isBoilerplateDir('src/index.ts', false), false);
    assert.equal(isBoilerplateDir('node_modules', true), true);
    assert.equal(isGeneratedFile('bundle.min.js'), true);
    assert.equal(isGeneratedFile('pnpm-lock.yaml'), true);
    assert.equal(isGeneratedFile('index.ts'), false);
  });
});

describe('ignore: gitignore parsing', () => {
  it('supports negation, dir-only and anchoring', () => {
    const rules = parseGitignore('logs/\n*.log\n!keep.log\n/docs/build/\n', 'root');
    // dir-only pattern matches the dir and everything inside
    assert.equal(isIgnored('logs/a.txt', false, [rules]), true);
    assert.equal(isIgnored('docs/build/app.js', false, [rules]), true);
    // basename glob
    assert.equal(isIgnored('src/debug.log', false, [rules]), true);
    // negation wins on exact match
    assert.equal(isIgnored('src/keep.log', false, [rules]), false);
    // anchored dir-only does not leak
    assert.equal(isIgnored('app/docs/build/x.js', false, [rules]), false);
    // untouched path
    assert.equal(isIgnored('src/a.ts', false, [rules]), false);
  });
});
