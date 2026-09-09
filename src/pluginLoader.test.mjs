import test from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPlugins,
  validatePluginDescriptor,
  validatePluginManifest,
} from './pluginLoader.js';

/** A minimal layer that satisfies the plugin-layer interface. */
function goodLayer(overrides = {}) {
  return {
    id: 'hello-layer',
    name: 'Hello Plugin',
    icon: '🧩',
    showInTogglePanel: true,
    init() {},
    enable() {},
    disable() {},
    update() { return Promise.resolve(); },
    destroy() {},
    getStats() { return { count: 0 }; },
    ...overrides,
  };
}

/** A descriptor that passes validation. */
function goodDescriptor(overrides = {}) {
  return {
    id: 'hello-layer-plugin',
    version: '0.1.0',
    name: 'Hello Layer',
    layers: [goodLayer()],
    share: [{ id: 'hello-layer', token: 'p' }],
    credits: [{ key: 'hello-layer', html: 'Hello Layer demo plugin' }],
    ...overrides,
  };
}

function okResponse(body) {
  return { ok: true, status: 200, text: async () => body };
}

function notFoundResponse() {
  return { ok: false, status: 404, text: async () => '' };
}

test('validatePluginManifest: 404 yields no plugins (handled by loadPlugins)', () => {
  const { plugins, errors } = validatePluginManifest({ plugins: ['./plugins/hello-layer/index.js'] });
  assert.deepEqual(plugins, ['./plugins/hello-layer/index.js']);
  assert.deepEqual(errors, []);
});

test('validatePluginManifest: rejects non-relative, off-origin, and ".." entries', () => {
  const { plugins, errors } = validatePluginManifest({
    plugins: [
      './plugins/hello-layer/index.js',
      '/plugins/hello-layer/index.js',
      'plugins/hello-layer/index.js',
      './plugins/../core/index.js',
      'https://evil.example/hello.js',
      './plugins/hello.txt',
      42,
    ],
  });
  assert.deepEqual(plugins, ['./plugins/hello-layer/index.js']);
  assert.equal(errors.length, 6);
  assert.match(errors[1], /must be a relative/);
});

test('validatePluginManifest: bad shape errors', () => {
  assert.match(validatePluginManifest(null).errors[0], /object with a "plugins" array/);
  assert.match(validatePluginManifest({ plugins: 'x' }).errors[0], /array of strings/);
});

test('validatePluginDescriptor: accepts a well-formed descriptor', () => {
  const r = validatePluginDescriptor(goodDescriptor(), {
    existingLayerIds: new Set(['earthquakes']),
    existingTokens: new Set(['a', 'e']),
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
});

test('validatePluginDescriptor: bad plugin id', () => {
  const r = validatePluginDescriptor(goodDescriptor({ id: 'Bad ID' }), {
    existingLayerIds: new Set(),
    existingTokens: new Set(),
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /id must match/);
});

test('validatePluginDescriptor: duplicate layer id vs existingLayerIds', () => {
  const r = validatePluginDescriptor(
    goodDescriptor({ layers: [goodLayer({ id: 'earthquakes' })] }),
    { existingLayerIds: new Set(['earthquakes']), existingTokens: new Set() },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /collides with an existing layer id: earthquakes/);
});

test('validatePluginDescriptor: share token collision', () => {
  const r = validatePluginDescriptor(
    goodDescriptor({ share: [{ id: 'hello-layer', token: 'e' }] }),
    { existingLayerIds: new Set(), existingTokens: new Set(['e']) },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /collides with an existing token: e/);
});

test('validatePluginDescriptor: missing layer interface fields', () => {
  const broken = { id: 'hello-layer', name: 'Hello', init() {}, enable() {}, disable() {} };
  const r = validatePluginDescriptor(goodDescriptor({ layers: [broken] }), {
    existingLayerIds: new Set(),
    existingTokens: new Set(),
  });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('; '), /missing interface fields/);
});

test('loadPlugins: 404 manifest -> no plugins, no errors', async () => {
  const loaded = await loadPlugins({
    fetchImpl: async () => notFoundResponse(),
    importer: async () => { throw new Error('should not import'); },
    ctx: {},
    existingLayerIds: [],
    existingTokens: [],
  });
  assert.deepEqual(loaded.plugins, []);
  assert.deepEqual(loaded.shareEntries, []);
  assert.deepEqual(loaded.errors, []);
});

test('loadPlugins: SPA-fallback HTML on 200 -> silent no-manifest (no errors)', async () => {
  // Vite dev server returns index.html with HTTP 200 for a missing root file
  // (no 404). That must be treated as "no manifest present", not a malformed
  // manifest: zero plugins, zero errors, zero console noise.
  const loaded = await loadPlugins({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<!DOCTYPE html><html>…' }),
    importer: async () => { throw new Error('should not import'); },
    ctx: {},
    existingLayerIds: [],
    existingTokens: [],
  });
  assert.deepEqual(loaded.plugins, []);
  assert.deepEqual(loaded.shareEntries, []);
  assert.deepEqual(loaded.errors, []);
});

test('loadPlugins: malformed manifest JSON -> one error, no plugins', async () => {
  const loaded = await loadPlugins({
    fetchImpl: async () => okResponse('{ not json'),
    importer: async () => { throw new Error('nope'); },
    ctx: {},
    existingLayerIds: [],
    existingTokens: [],
  });
  assert.deepEqual(loaded.plugins, []);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0].error, /malformed manifest JSON/);
});

test('loadPlugins: failure isolation — one throwing plugin + one good plugin', async () => {
  const goodModule = { default: () => goodDescriptor() };
  const calls = [];
  const importer = async (spec) => {
    calls.push(spec);
    if (spec.includes('broken')) throw new Error('boom');
    return goodModule;
  };
  const loaded = await loadPlugins({
    fetchImpl: async () => okResponse(JSON.stringify({
      plugins: ['./plugins/broken/index.js', './plugins/hello-layer/index.js'],
    })),
    importer,
    ctx: {},
    existingLayerIds: [],
    existingTokens: [],
  });
  assert.equal(loaded.plugins.length, 1);
  assert.equal(loaded.plugins[0].id, 'hello-layer-plugin');
  assert.equal(loaded.shareEntries.length, 1);
  assert.equal(loaded.shareEntries[0].disposition, 'enabled-only');
  assert.equal(loaded.shareEntries[0].token, 'p');
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0].spec, /broken/);
  assert.match(loaded.errors[0].error, /import failed/);
  assert.deepEqual(calls, ['./plugins/broken/index.js', './plugins/hello-layer/index.js']);
});

test('loadPlugins: createPlugin that throws is recorded and skipped', async () => {
  const throwingModule = { default: () => { throw new Error('factory boom'); } };
  const loaded = await loadPlugins({
    fetchImpl: async () => okResponse(JSON.stringify({
      plugins: ['./plugins/throws/index.js'],
    })),
    importer: async () => throwingModule,
    ctx: {},
    existingLayerIds: [],
    existingTokens: [],
  });
  assert.deepEqual(loaded.plugins, []);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0].error, /createPlugin threw/);
});

test('loadPlugins: descriptor failing validation is recorded, nothing emitted', async () => {
  const badModule = { default: () => goodDescriptor({ id: 'BAD' }) };
  const loaded = await loadPlugins({
    fetchImpl: async () => okResponse(JSON.stringify({
      plugins: ['./plugins/bad/index.js'],
    })),
    importer: async () => badModule,
    ctx: {},
    existingLayerIds: [],
    existingTokens: [],
  });
  assert.deepEqual(loaded.plugins, []);
  assert.deepEqual(loaded.shareEntries, []);
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0].error, /id must match/);
});

test('loadPlugins: accepted descriptor shareEntries are enabled-only', async () => {
  const goodModule = { default: () => goodDescriptor() };
  const loaded = await loadPlugins({
    fetchImpl: async () => okResponse(JSON.stringify({
      plugins: ['./plugins/hello-layer/index.js'],
    })),
    importer: async () => goodModule,
    ctx: {},
    existingLayerIds: ['flights'],
    existingTokens: ['f'],
  });
  assert.equal(loaded.plugins.length, 1);
  for (const entry of loaded.shareEntries) {
    assert.equal(entry.disposition, 'enabled-only');
  }
});

test('loadPlugins: two plugins in one manifest cannot collide ids/tokens', async () => {
  const a = { default: () => goodDescriptor() };
  const b = { default: () => goodDescriptor() }; // same ids/tokens -> must be rejected
  const importer = async (spec) => (spec.includes('two') ? b : a);
  const loaded = await loadPlugins({
    fetchImpl: async () => okResponse(JSON.stringify({
      plugins: ['./plugins/one/index.js', './plugins/two/index.js'],
    })),
    importer,
    ctx: {},
    existingLayerIds: [],
    existingTokens: [],
  });
  assert.equal(loaded.plugins.length, 1);
  assert.equal(loaded.plugins[0].id, 'hello-layer-plugin');
  assert.ok(loaded.errors.length >= 1, 'expected at least one collision error');
  assert.match(loaded.errors.map((e) => e.error).join('; '), /collides/);
});
