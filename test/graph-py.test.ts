import { assert, describe, it, makeRepo } from './helpers.js';
import { buildGraph } from '../src/core/graph.js';
import { scanRepo } from '../src/core/scanner.js';
import { PROFILES } from '../src/core/types.js';

describe('graph: python import resolution', () => {
  it('resolves relative imports including dotted package paths', () => {
    // regression: `from .agent.service import Z` previously failed because the
    // leading dots were not converted into directory hops.
    const repo = makeRepo({
      'pyproject.toml': '[project]\nname = "svc"\n',
      'main.py': 'import app.agent.service\nfrom app import sibling\n',
      'app/__main__.py': 'from .agent.service import Z\nfrom . import sibling2\n',
      'app/__init__.py': '',
      'app/sibling.py': 'x = 1',
      'app/sibling2.py': 'x = 2',
      'app/agent/__init__.py': '',
      'app/agent/service.py': 'class Z: pass',
      'app/other.py': 'y = 2',
    });
    const scan = scanRepo(repo, PROFILES.balanced);
    const g = buildGraph(repo, scan.files);

    assert.ok(g.entries.includes('main.py'), `entries: ${JSON.stringify(g.entries)}`);

    // absolute import of a dotted module path
    const mainImports = g.imports.get('main.py') ?? [];
    assert.equal(
      mainImports.includes('app/agent/service.py'),
      true,
      `expected app/agent/service.py in ${JSON.stringify(mainImports)}`
    );
    // `from app import sibling` resolves to the sibling module, not __init__
    assert.equal(mainImports.includes('app/sibling.py'), true);

    // THE regression: relative dotted import from inside app/
    const dunderImports = g.imports.get('app/__main__.py') ?? [];
    assert.equal(
      dunderImports.includes('app/agent/service.py'),
      true,
      `expected app/agent/service.py in ${JSON.stringify(dunderImports)}`
    );
    // `from . import sibling2` -> app/sibling2.py
    assert.equal(dunderImports.includes('app/sibling2.py'), true);

    // app/other.py is unreachable -> cold (app/__main__.py itself is not an
    // entry candidate either)
    assert.ok(g.cold.includes('app/other.py'), `cold: ${JSON.stringify(g.cold)}`);
  });

  it('resolves absolute module imports and from-import symbols', () => {
    const repo = makeRepo({
      'run.py': 'import lib.core\nfrom lib.utils import format_x\n',
      'lib/__init__.py': '',
      'lib/core.py': 'CORE = 1',
      'lib/utils.py': 'def format_x(): pass',
      'lib/cli_tool.py': 'import argparse', // not imported by anything -> cold
    });
    const scan = scanRepo(repo, PROFILES.balanced);
    const g = buildGraph(repo, scan.files);
    const runImports = g.imports.get('run.py') ?? [];
    assert.equal(runImports.includes('lib/core.py'), true);
    assert.equal(runImports.includes('lib/utils.py'), true);
    assert.deepEqual(g.cold, ['lib/cli_tool.py']);
  });
});
