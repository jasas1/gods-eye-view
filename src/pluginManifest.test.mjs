import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  normalizePluginManifest,
  safeJoinInside,
  readPluginManifest,
  createPluginRequestHandler,
  gevPluginsVitePlugin,
} from '../scripts/plugin-manifest.mjs';

/** Make a throwaway temp dir and return { root, cleanup }. */
function makeTempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pm-'));
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// normalizePluginManifest
// ---------------------------------------------------------------------------

test('normalizePluginManifest: string entries pass through under the client rules', () => {
  const { rootEntries, externals, clientManifest, errors } =
    normalizePluginManifest(
      {
        plugins: [
          './plugins/hello-layer/index.js',
          '/x.js',
          './plugins/../core/index.js',
          7,
        ],
      },
      { root: process.cwd() },
    );
  assert.deepEqual(rootEntries, ['./plugins/hello-layer/index.js']);
  assert.deepEqual(externals, []);
  assert.deepEqual(clientManifest.plugins, ['./plugins/hello-layer/index.js']);
  assert.equal(errors.length, 3);
});

test('normalizePluginManifest: object entries need name/dir/entry rules', () => {
  const extRoot = mkdtempSync(path.join(tmpdir(), 'gev-pm-ext-'));
  try {
    const { rootEntries, externals, clientManifest, errors } =
      normalizePluginManifest(
        {
          plugins: [
            { name: 'ext-demo', dir: extRoot }, // default entry index.js
            { name: 'Bad Name', dir: extRoot }, // bad name
            { name: 'ext-demo', dir: extRoot }, // duplicate
            { name: 'no-dir' }, // missing dir
            { name: 'reldir', dir: 'relative/path' }, // non-absolute
            { name: 'missing', dir: path.join(extRoot, 'does-not-exist') }, // missing dir
            { name: 'bad-entry', dir: extRoot, entry: 'sub/x.js' }, // slashes
            { name: 'bad-entry2', dir: extRoot, entry: 'x.txt' }, // wrong ext
            'not-an-object',
          ],
        },
        { root: process.cwd() },
      );
    assert.deepEqual(rootEntries, []);
    assert.equal(externals.length, 1);
    assert.deepEqual(externals[0], {
      name: 'ext-demo',
      dir: extRoot,
      entry: 'index.js',
    });
    assert.deepEqual(clientManifest.plugins, ['./plugins/ext-demo/index.js']);
    assert.ok(
      errors.length >= 7,
      `expected several errors, got ${errors.length}`,
    );
  } finally {
    rmSync(extRoot, { recursive: true, force: true });
  }
});

test('normalizePluginManifest: rejects duplicate external names', () => {
  const extRoot = mkdtempSync(path.join(tmpdir(), 'gev-pm-dup-'));
  try {
    const { externals, errors } = normalizePluginManifest(
      {
        plugins: [
          { name: 'dup', dir: extRoot },
          { name: 'dup', dir: extRoot, entry: 'other.mjs' },
        ],
      },
      { root: process.cwd() },
    );
    assert.equal(externals.length, 1);
    assert.equal(externals[0].entry, 'index.js');
    assert.ok(errors.some((e) => /duplicated/.test(e)));
  } finally {
    rmSync(extRoot, { recursive: true, force: true });
  }
});

test('normalizePluginManifest: clientManifest paths are ./plugins/<name>/<entry>', () => {
  const extRoot = mkdtempSync(path.join(tmpdir(), 'gev-pm-paths-'));
  try {
    const { clientManifest } = normalizePluginManifest(
      {
        plugins: [
          './plugins/hello-layer/index.js',
          { name: 'a', dir: extRoot },
          { name: 'b', dir: extRoot, entry: 'main.mjs' },
        ],
      },
      { root: process.cwd() },
    );
    assert.deepEqual(clientManifest.plugins, [
      './plugins/hello-layer/index.js',
      './plugins/a/index.js',
      './plugins/b/main.mjs',
    ]);
  } finally {
    rmSync(extRoot, { recursive: true, force: true });
  }
});

test('normalizePluginManifest: bad shape errors', () => {
  assert.match(
    normalizePluginManifest(null, { root: process.cwd() }).errors[0],
    /object with a "plugins" array/,
  );
  assert.match(
    normalizePluginManifest({ plugins: 'x' }, { root: process.cwd() })
      .errors[0],
    /must be an array/,
  );
});

// ---------------------------------------------------------------------------
// safeJoinInside
// ---------------------------------------------------------------------------

test('safeJoinInside: serves a normal file inside the dir', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-pm-safe-'));
  try {
    writeFileSync(path.join(dir, 'index.js'), 'export default 1');
    // safeJoinInside returns the realpath-resolved location (so a symlinked
    // tmpdir on some hosts does not break the comparison).
    const resolved = safeJoinInside(dir, 'index.js');
    assert.equal(resolved, realpathSync(path.join(dir, 'index.js')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safeJoinInside: rejects "..", encoded "%2e%2e", backslash, and absolute traversal', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-pm-trav-'));
  try {
    mkdirSync(path.join(dir, 'sub'));
    writeFileSync(path.join(dir, 'index.js'), 'x');
    writeFileSync(path.join(dir, 'secret.txt'), 'TOPSECRET');

    assert.equal(safeJoinInside(dir, '../secret.txt'), null);
    assert.equal(safeJoinInside(dir, '%2e%2e/secret.txt'), null);
    assert.equal(safeJoinInside(dir, '..%2f..%2fsecret.txt'), null);
    assert.equal(safeJoinInside(dir, 'sub/../../secret.txt'), null);
    assert.equal(safeJoinInside(dir, '\\..\\secret.txt'), null);
    assert.equal(safeJoinInside(dir, '/etc/passwd'), null);
    assert.equal(safeJoinInside(dir, ''), null);
    // A legitimate nested file still resolves.
    writeFileSync(path.join(dir, 'sub', 'a.js'), 'y');
    assert.equal(
      safeJoinInside(dir, 'sub/a.js'),
      realpathSync(path.join(dir, 'sub', 'a.js')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safeJoinInside: rejects a symlink pointing outside the dir', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-pm-link-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'gev-pm-out-'));
  try {
    writeFileSync(path.join(outside, 'leak.js'), 'LEAKED');
    symlinkSync(path.join(outside, 'leak.js'), path.join(dir, 'leak.js'));
    assert.equal(safeJoinInside(dir, 'leak.js'), null);
    // A symlink pointing inside the dir resolves to the real target.
    writeFileSync(path.join(dir, 'real.js'), 'ok');
    symlinkSync(path.join(dir, 'real.js'), path.join(dir, 'inside.js'));
    assert.equal(
      safeJoinInside(dir, 'inside.js'),
      realpathSync(path.join(dir, 'real.js')),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('safeJoinInside: null when file does not exist', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-pm-missing-'));
  try {
    assert.equal(safeJoinInside(dir, 'nope.js'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// readPluginManifest
// ---------------------------------------------------------------------------

test('readPluginManifest: absent file returns null (silent)', () => {
  const { root, cleanup } = makeTempRoot();
  try {
    assert.equal(readPluginManifest(root), null);
  } finally {
    cleanup();
  }
});

test('readPluginManifest: malformed JSON warns and returns errors', () => {
  const { root, cleanup } = makeTempRoot();
  const warns = [];
  const originalWarn = console.warn;
  console.warn = (msg) => warns.push(String(msg));
  try {
    writeFileSync(path.join(root, 'gev.plugins.json'), '{ not json');
    const result = readPluginManifest(root);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0], /malformed/);
    assert.ok(warns.some((w) => w.startsWith('[gev plugins]')));
  } finally {
    console.warn = originalWarn;
    cleanup();
  }
});

test('readPluginManifest: valid manifest normalizes', () => {
  const { root, cleanup } = makeTempRoot();
  const ext = mkdtempSync(path.join(tmpdir(), 'gev-pm-valid-'));
  try {
    writeFileSync(
      path.join(root, 'gev.plugins.json'),
      JSON.stringify({
        plugins: ['./plugins/hello-layer/index.js', { name: 'ext', dir: ext }],
      }),
    );
    const result = readPluginManifest(root);
    assert.deepEqual(result.rootEntries, ['./plugins/hello-layer/index.js']);
    assert.equal(result.externals.length, 1);
    assert.deepEqual(result.clientManifest.plugins, [
      './plugins/hello-layer/index.js',
      './plugins/ext/index.js',
    ]);
    assert.equal(result.errors.length, 0);
  } finally {
    rmSync(ext, { recursive: true, force: true });
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// middleware handler (createPluginRequestHandler)
// ---------------------------------------------------------------------------

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.ended = true;
      this.body = body === undefined ? null : body;
    },
  };
}

function buildHandler(root) {
  const handler = createPluginRequestHandler(root);
  return (url, method = 'GET') =>
    new Promise((resolve) => {
      const req = { url, method };
      const res = fakeRes();
      const next = () => resolve({ passed: true, res });
      handler(req, res, next);
      if (res.ended) resolve({ passed: false, res });
    });
}

test('middleware: serves /gev.plugins.json normalized (no absolute paths)', async () => {
  const { root, cleanup } = makeTempRoot();
  const ext = mkdtempSync(path.join(tmpdir(), 'gev-pm-mw-'));
  try {
    writeFileSync(
      path.join(root, 'gev.plugins.json'),
      JSON.stringify({
        plugins: [{ name: 'ext-demo', dir: ext, entry: 'index.js' }],
      }),
    );
    const invoke = buildHandler(root);
    const r = await invoke('/gev.plugins.json');
    assert.equal(r.passed, false);
    assert.equal(r.res.statusCode, 200);
    assert.equal(r.res.headers['Content-Type'], 'application/json');
    assert.equal(r.res.headers['Cache-Control'], 'no-store');
    const body = JSON.parse(String(r.res.body));
    assert.deepEqual(body, { plugins: ['./plugins/ext-demo/index.js'] });
    assert.ok(
      !String(r.res.body).includes(ext),
      'client manifest must not leak the absolute dir',
    );
  } finally {
    rmSync(ext, { recursive: true, force: true });
    cleanup();
  }
});

test('middleware: serves external index.js with text/javascript', async () => {
  const { root, cleanup } = makeTempRoot();
  const ext = mkdtempSync(path.join(tmpdir(), 'gev-pm-srv-'));
  try {
    writeFileSync(path.join(ext, 'index.js'), "export default 'ext';");
    writeFileSync(path.join(ext, 'points.js'), 'export const P = 1;');
    writeFileSync(
      path.join(root, 'gev.plugins.json'),
      JSON.stringify({ plugins: [{ name: 'ext-demo', dir: ext }] }),
    );
    const invoke = buildHandler(root);
    const a = await invoke('/plugins/ext-demo/index.js');
    assert.equal(a.passed, false);
    assert.equal(a.res.headers['Content-Type'], 'text/javascript');
    assert.equal(String(a.res.body), "export default 'ext';");
    const b = await invoke('/plugins/ext-demo/points.js');
    assert.equal(b.res.headers['Content-Type'], 'text/javascript');
    assert.ok(String(b.res.body).includes('export const P'));
  } finally {
    rmSync(ext, { recursive: true, force: true });
    cleanup();
  }
});

test('middleware: 404 for a traversal attempt', async () => {
  const { root, cleanup } = makeTempRoot();
  const ext = mkdtempSync(path.join(tmpdir(), 'gev-pm-travmw-'));
  try {
    writeFileSync(path.join(ext, 'index.js'), 'x');
    writeFileSync(path.join(ext, 'secret.txt'), 'TOPSECRET');
    writeFileSync(
      path.join(root, 'gev.plugins.json'),
      JSON.stringify({ plugins: [{ name: 'ext-demo', dir: ext }] }),
    );
    const invoke = buildHandler(root);
    for (const url of [
      '/plugins/ext-demo/../secret.txt',
      '/plugins/ext-demo/%2e%2e/secret.txt',
    ]) {
      const r = await invoke(url);
      assert.equal(r.passed, false);
      assert.equal(r.res.statusCode, 404);
      assert.ok(!String(r.res.body).includes('TOPSECRET'), `leaked via ${url}`);
    }
  } finally {
    rmSync(ext, { recursive: true, force: true });
    cleanup();
  }
});

test('middleware: 404 for an unknown plugin name', async () => {
  const { root, cleanup } = makeTempRoot();
  const ext = mkdtempSync(path.join(tmpdir(), 'gev-pm-unk-'));
  try {
    writeFileSync(path.join(ext, 'index.js'), 'x');
    writeFileSync(
      path.join(root, 'gev.plugins.json'),
      JSON.stringify({ plugins: [{ name: 'ext-demo', dir: ext }] }),
    );
    const invoke = buildHandler(root);
    // Unknown external name falls through to next() (Vite/SPA handles root plugins).
    const r = await invoke('/plugins/unknown/index.js');
    assert.equal(r.passed, true);
  } finally {
    rmSync(ext, { recursive: true, force: true });
    cleanup();
  }
});

test('middleware: no manifest -> /gev.plugins.json passes through (SPA fallback)', async () => {
  const { root, cleanup } = makeTempRoot();
  try {
    const invoke = buildHandler(root);
    const r = await invoke('/gev.plugins.json');
    assert.equal(r.passed, true);
  } finally {
    cleanup();
  }
});

test('middleware: unsupported extension -> 404', async () => {
  const { root, cleanup } = makeTempRoot();
  const ext = mkdtempSync(path.join(tmpdir(), 'gev-pm-ext404-'));
  try {
    writeFileSync(path.join(ext, 'index.js'), 'x');
    writeFileSync(path.join(ext, 'notes.txt'), 'n');
    writeFileSync(
      path.join(root, 'gev.plugins.json'),
      JSON.stringify({ plugins: [{ name: 'ext-demo', dir: ext }] }),
    );
    const invoke = buildHandler(root);
    const r = await invoke('/plugins/ext-demo/notes.txt');
    assert.equal(r.passed, false);
    assert.equal(r.res.statusCode, 404);
  } finally {
    rmSync(ext, { recursive: true, force: true });
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// gevPluginsVitePlugin (build path: closeBundle copies plugins into outDir)
// ---------------------------------------------------------------------------

test('gevPluginsVitePlugin: closeBundle copies root + external plugins and writes the client manifest', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pm-build-'));
  const outDir = path.join(root, 'dist');
  const ext = mkdtempSync(path.join(tmpdir(), 'gev-pm-buildext-'));
  try {
    // Root plugin under <root>/plugins/hello-layer
    mkdirSync(path.join(root, 'plugins', 'hello-layer'), { recursive: true });
    writeFileSync(
      path.join(root, 'plugins', 'hello-layer', 'index.js'),
      'export default 1;',
    );
    writeFileSync(
      path.join(root, 'plugins', 'hello-layer', '.dotfile'),
      'skip',
    );
    // External plugin with a sibling file + node_modules (must be skipped).
    writeFileSync(path.join(ext, 'index.js'), "import './points.js';");
    writeFileSync(path.join(ext, 'points.js'), 'export const P = 1;');
    mkdirSync(path.join(ext, 'node_modules'));
    writeFileSync(path.join(ext, 'node_modules', 'evil.js'), 'leak');

    writeFileSync(
      path.join(root, 'gev.plugins.json'),
      JSON.stringify({
        plugins: [
          './plugins/hello-layer/index.js',
          { name: 'ext-demo', dir: ext },
        ],
      }),
    );

    const plugin = gevPluginsVitePlugin();
    plugin.configResolved({ root, build: { outDir: 'dist' } });
    plugin.closeBundle();

    assert.ok(
      existsSync(path.join(outDir, 'gev.plugins.json')),
      'dist manifest written',
    );
    const distManifest = JSON.parse(
      readFileSync(path.join(outDir, 'gev.plugins.json'), 'utf8'),
    );
    assert.deepEqual(distManifest.plugins, [
      './plugins/hello-layer/index.js',
      './plugins/ext-demo/index.js',
    ]);
    assert.ok(
      existsSync(path.join(outDir, 'plugins', 'hello-layer', 'index.js')),
    );
    assert.ok(existsSync(path.join(outDir, 'plugins', 'ext-demo', 'index.js')));
    assert.ok(
      existsSync(path.join(outDir, 'plugins', 'ext-demo', 'points.js')),
    );
    assert.ok(
      !existsSync(path.join(outDir, 'plugins', 'ext-demo', 'node_modules')),
      'node_modules skipped',
    );
    assert.ok(
      !existsSync(path.join(outDir, 'plugins', 'hello-layer', '.dotfile')),
      'dotfile skipped',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }
});

test('gevPluginsVitePlugin: no manifest -> closeBundle writes nothing', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gev-pm-nomanifest-'));
  const outDir = path.join(root, 'dist');
  try {
    const plugin = gevPluginsVitePlugin();
    plugin.configResolved({ root, build: { outDir: 'dist' } });
    plugin.closeBundle();
    assert.ok(!existsSync(outDir), 'no dist created when no manifest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('gevPluginsVitePlugin: configureServer registers a middleware', () => {
  const { root, cleanup } = makeTempRoot();
  try {
    const plugin = gevPluginsVitePlugin();
    let registered = null;
    plugin.configureServer({
      middlewares: {
        use(fn) {
          registered = fn;
        },
      },
      config: { root },
    });
    assert.equal(typeof registered, 'function');
  } finally {
    cleanup();
  }
});
