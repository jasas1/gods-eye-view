/**
 * Runtime plugin loader for God's Eye View.
 *
 * A third party ships a data layer as an external ES module listed in a
 * `gev.plugins.json` manifest at the repo root. The loader fetches the
 * manifest, validates it, dynamically imports each entry, runs the plugin's
 * `createPlugin(ctx)` factory, validates the returned descriptor, and hands
 * the accepted descriptors + share-token entries back to the caller. The
 * caller (src/standalone/plugins.js) then registers the layers into the
 * catalog before the data manager is sealed.
 *
 * Design constraints:
 *  - Manifest entries are same-origin relative `./`-prefixed `.js`/`.mjs`
 *    paths only (no `..`, no absolute, no off-origin). The manifest cannot
 *    point off-origin.
 *  - Failure isolation is mandatory: a missing manifest (HTTP 404) is the
 *    "no plugins" signal and is silent; a malformed manifest, an import
 *    that throws, a `createPlugin` that throws, or a descriptor that fails
 *    validation is recorded once in `errors`, logged once, and skipped. The
 *    loader never throws and never leaves a half-accepted plugin.
 *  - The whole descriptor is validated BEFORE any of its layers/credits/share
 *    entries are emitted, so a bad plugin contributes nothing to the output.
 *  - `share` is optional, but every accepted layer ENDS UP with a token:
 *    a layer without a `share` entry gets one AUTO-ASSIGNED from the free
 *    pool (digits '0'-'9' then letters 'a'-'z', skipping every token already
 *    claimed by built-ins, earlier plugins, or an explicit token in the same
 *    plugin). Collision with an EXPLICIT token stays a hard rejection of the
 *    whole plugin, exactly as before; only the un-tokened layers are filled
 *    in. The returned `shareEntries` therefore carries one entry per accepted
 *    plugin layer.
 *
 * This module is browser-safe: no `node:*` imports. `fetch` and dynamic
 * `import()` are injectable so the unit suite can run under node:test.
 */

/** Plugin/layer id grammar — same rule as the layer-state registry. */
const ID_RE = /^[a-z0-9-]+$/;
/** Share tokens are a single [a-z0-9] character, matching the registry. */
const TOKEN_RE = /^[a-z0-9]$/;
/**
 * Ordered free-token pool for auto-assignment: digits first, then letters.
 * Mirrors the layer-state registry's single-character token grammar.
 */
const TOKEN_POOL = Object.freeze([
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
]);

/**
 * Decide whether a manifest entry is an allowed same-origin plugin path.
 * @param {string} spec - Candidate module specifier from the manifest.
 * @returns {boolean} True when the spec is a relative `./…js|./…mjs` path
 *   with no parent-traversal (`..`) segment and no scheme.
 */
function isAllowedPluginPath(spec) {
  if (typeof spec !== 'string' || spec.length === 0) return false;
  if (!spec.startsWith('./')) return false;
  if (spec.includes('://')) return false;
  if (!spec.endsWith('.js') && !spec.endsWith('.mjs')) return false;
  const segments = spec.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '') return false;
  }
  return true;
}

/**
 * Find the next free single-character token not already in `claimed`, or
 * `null` when the pool is exhausted.
 * @param {Set<string>} claimed - Tokens already in use.
 * @returns {string|null}
 */
function nextFreeToken(claimed) {
  for (const token of TOKEN_POOL) {
    if (!claimed.has(token)) return token;
  }
  return null;
}

/**
 * Validate a parsed manifest object.
 *
 * @param {unknown} json - The parsed manifest (object with a `plugins` array).
 * @returns {{ plugins: string[], errors: string[] }} `plugins` is the list of
 *   allowed module specifiers; `errors` lists every rejected entry/shape
 *   problem. Bad entries do not reject the good ones.
 */
export function validatePluginManifest(json) {
  const plugins = [];
  const errors = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    errors.push('manifest must be an object with a "plugins" array');
    return { plugins, errors };
  }
  const raw = json.plugins;
  if (!Array.isArray(raw)) {
    errors.push('manifest "plugins" must be an array of strings');
    return { plugins, errors };
  }
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      errors.push(`manifest entry is not a string: ${String(entry)}`);
      continue;
    }
    if (!isAllowedPluginPath(entry)) {
      errors.push(
        `manifest entry rejected (must be a relative ./*.js|.mjs path with no ".."): ${entry}`,
      );
      continue;
    }
    plugins.push(entry);
  }
  return { plugins, errors };
}

/**
 * Validate a plugin descriptor returned by `createPlugin`.
 *
 * @param {unknown} descriptor - The descriptor to validate.
 * @param {{ existingLayerIds: Set<string>, existingTokens: Set<string> }} sets -
 *   Layer ids and single-char tokens already claimed (built-ins plus any
 *   plugins accepted earlier in this load pass).
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePluginDescriptor(
  descriptor,
  { existingLayerIds, existingTokens },
) {
  const errors = [];
  if (
    !descriptor ||
    typeof descriptor !== 'object' ||
    Array.isArray(descriptor)
  ) {
    return { ok: false, errors: ['plugin descriptor must be an object'] };
  }
  const { id, version, name, layers, share, credits } = descriptor;

  if (typeof id !== 'string' || !ID_RE.test(id)) {
    errors.push('plugin descriptor id must match /^[a-z0-9-]+$/');
  } else if (existingLayerIds.has(id)) {
    errors.push(`plugin id collides with an existing layer id: ${id}`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    errors.push('plugin descriptor version must be a non-empty string');
  }
  if (typeof name !== 'string' || name.length === 0) {
    errors.push('plugin descriptor name must be a non-empty string');
  }
  if (!Array.isArray(layers)) {
    errors.push('plugin descriptor layers must be an array');
    return { ok: errors.length === 0, errors };
  }

  const layerIds = new Set();
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') {
      errors.push('plugin layer must be an object');
      continue;
    }
    const missing = [];
    for (const field of ['id', 'name', 'icon', 'showInTogglePanel']) {
      if (layer[field] === undefined) missing.push(field);
    }
    for (const fn of [
      'init',
      'enable',
      'disable',
      'update',
      'destroy',
      'getStats',
    ]) {
      if (typeof layer[fn] !== 'function') missing.push(fn);
    }
    if (missing.length) {
      errors.push(
        `plugin layer missing interface fields: ${missing.join(', ')}`,
      );
      continue;
    }
    if (typeof layer.id !== 'string' || !ID_RE.test(layer.id)) {
      errors.push(
        `plugin layer id must match /^[a-z0-9-]+$/: ${String(layer.id)}`,
      );
      continue;
    }
    if (existingLayerIds.has(layer.id)) {
      errors.push(
        `plugin layer id collides with an existing layer id: ${layer.id}`,
      );
    } else if (layerIds.has(layer.id)) {
      errors.push(`plugin layer id duplicated within the plugin: ${layer.id}`);
    } else {
      layerIds.add(layer.id);
    }
  }

  // share tokens: optional, one { id, token } per layer, 'enabled-only' only.
  // Collision with an EXPLICIT token is a hard rejection of the plugin; layers
  // without a share entry are filled in by auto-assignment AFTER validation.
  const shareTokens = new Set();
  if (share !== undefined) {
    if (!Array.isArray(share)) {
      errors.push('plugin share must be an array of { id, token }');
    } else {
      for (const entry of share) {
        if (!entry || typeof entry !== 'object') {
          errors.push('plugin share entry must be an object');
          continue;
        }
        if (typeof entry.id !== 'string' || !layerIds.has(entry.id)) {
          errors.push(
            `plugin share id must reference one of the plugin's layers: ${String(entry?.id)}`,
          );
        }
        if (typeof entry.token !== 'string' || !TOKEN_RE.test(entry.token)) {
          errors.push(
            `plugin share token must be a single [a-z0-9] char: ${String(entry?.token)}`,
          );
          continue;
        }
        if (existingTokens.has(entry.token)) {
          errors.push(
            `plugin share token collides with an existing token: ${entry.token}`,
          );
        } else if (shareTokens.has(entry.token)) {
          errors.push(
            `plugin share token duplicated within the plugin: ${entry.token}`,
          );
        } else {
          shareTokens.add(entry.token);
        }
      }
    }
  }

  if (credits !== undefined) {
    if (!Array.isArray(credits)) {
      errors.push('plugin credits must be an array of { key, html }');
    } else {
      for (const credit of credits) {
        if (!credit || typeof credit !== 'object') {
          errors.push('plugin credit entry must be an object');
          continue;
        }
        if (typeof credit.key !== 'string' || credit.key.length === 0) {
          errors.push('plugin credit key must be a non-empty string');
        }
        if (typeof credit.html !== 'string' || credit.html.length === 0) {
          errors.push('plugin credit html must be a non-empty string');
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Load and validate every plugin listed in the manifest.
 *
 * @param {object} options
 * @param {string} [options.manifestUrl='/gev.plugins.json'] - URL fetched for
 *   the manifest. A non-OK response (404) means "no plugins" and is silent.
 * @param {function} [options.fetchImpl=fetch] - Injectable fetch (tests).
 * @param {function} [options.importer] - Injectable dynamic import returning a
 *   module namespace. Default uses native `import()` with a `@vite-ignore`
 *   comment so Vite leaves the runtime spec alone. The default importer
 *   rewrites a `./`-prefixed manifest entry to an origin-absolute path
 *   (`./plugins/x.js` -> `/plugins/x.js`) so the import resolves from the
 *   repo root regardless of which module hosts loadPlugins; a custom importer
 *   receives the original manifest entry unchanged.
 * @param {object} options.ctx - Shared to every `createPlugin`: `{ Cesium,
 *   viewer, registerDynamicCredit, layerFeedState }`.
 * @param {Iterable<string>} [options.existingLayerIds=[]] - Layer ids already
 *   claimed by built-ins (and earlier accepted plugins).
 * @param {Iterable<string>} [options.existingTokens=[]] - Single-char share
 *   tokens already claimed by the layer-state registry.
 * @returns {Promise<{ plugins: object[], shareEntries: { id: string, token: string, disposition: 'enabled-only' }[], errors: { spec: string, error: string }[] }>}
 *   `shareEntries` carries one entry per accepted plugin layer — explicit
 *   tokens first, then auto-assigned tokens for any layer without a `share`
 *   entry.
 */
export async function loadPlugins({
  manifestUrl = '/gev.plugins.json',
  fetchImpl = fetch,
  importer = (spec) => {
    // Manifest entries are repo-root-relative (`./…`). Resolve to an
    // origin-absolute path so the dynamic import loads from the repo root
    // instead of relative to this module's URL (/src/pluginLoader.js ->
    // /src/plugins/…). Non-`./` specs are passed through untouched so a custom
    // importer (tests) always sees the original manifest entry.
    const url = spec.startsWith('./') ? '/' + spec.slice(2) : spec;
    return import(/* @vite-ignore */ url);
  },
  ctx,
  existingLayerIds = [],
  existingTokens = [],
} = {}) {
  const plugins = [];
  const shareEntries = [];
  const errors = [];

  const claimedLayerIds = new Set(existingLayerIds);
  const claimedTokens = new Set(existingTokens);

  let response;
  try {
    response = await fetchImpl(manifestUrl);
  } catch (error) {
    errors.push({
      spec: manifestUrl,
      error: `fetch failed: ${describeError(error)}`,
    });
    console.error(
      `[gev plugins] manifest fetch failed: ${describeError(error)}`,
    );
    return { plugins, shareEntries, errors };
  }

  // 404 / any non-OK response means "no manifest present" — silent, no plugins.
  if (!response || !response.ok) {
    return { plugins, shareEntries, errors };
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    errors.push({
      spec: manifestUrl,
      error: `manifest read failed: ${describeError(error)}`,
    });
    console.error(
      `[gev plugins] manifest read failed: ${describeError(error)}`,
    );
    return { plugins, shareEntries, errors };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // A Vite dev-server SPA fallback serves index.html (HTTP 200, text/html)
    // for a missing root file instead of a 404. That body is not a real
    // malformed manifest the operator shipped — it is "no manifest present",
    // so it is silent. A genuinely broken JSON manifest (does not start with
    // '<') is still reported as malformed.
    if (text.trimStart().startsWith('<')) {
      return { plugins, shareEntries, errors };
    }
    errors.push({
      spec: manifestUrl,
      error: `malformed manifest JSON: ${describeError(error)}`,
    });
    console.error(
      `[gev plugins] malformed manifest JSON: ${describeError(error)}`,
    );
    return { plugins, shareEntries, errors };
  }

  const { plugins: specs, errors: manifestErrors } =
    validatePluginManifest(parsed);
  for (const message of manifestErrors) {
    errors.push({ spec: manifestUrl, error: message });
    console.error(`[gev plugins] ${message}`);
  }

  for (const spec of specs) {
    let moduleNs;
    try {
      moduleNs = await importer(spec);
    } catch (error) {
      errors.push({ spec, error: `import failed: ${describeError(error)}` });
      console.error(
        `[gev plugins] import failed for ${spec}: ${describeError(error)}`,
      );
      continue;
    }
    const createPlugin = moduleNs?.default;
    if (typeof createPlugin !== 'function') {
      errors.push({
        spec,
        error: 'module default export must be a createPlugin function',
      });
      console.error(
        `[gev plugins] ${spec}: default export must be a createPlugin function`,
      );
      continue;
    }
    let descriptor;
    try {
      descriptor = createPlugin(ctx || {});
    } catch (error) {
      errors.push({
        spec,
        error: `createPlugin threw: ${describeError(error)}`,
      });
      console.error(
        `[gev plugins] ${spec}: createPlugin threw: ${describeError(error)}`,
      );
      continue;
    }
    const validation = validatePluginDescriptor(descriptor, {
      existingLayerIds: claimedLayerIds,
      existingTokens: claimedTokens,
    });
    if (!validation.ok) {
      const id = descriptor?.id || spec;
      for (const message of validation.errors) {
        errors.push({ spec, error: message });
        console.error(`[gev plugins] ${id}: ${message}`);
      }
      continue;
    }

    // Accept the whole descriptor atomically: claim its ids/tokens before the
    // next plugin is validated so a later manifest entry cannot collide.
    // Explicit share tokens (already validated non-colliding) are claimed
    // first, then any layer WITHOUT a share entry gets an auto-assigned token
    // from the free pool so every accepted layer round-trips through a share
    // link. The trial set keeps a half-assigned plugin from claiming anything
    // when the pool is exhausted.
    const trialTokens = new Set(claimedTokens);
    const pluginShare = new Map();
    if (Array.isArray(descriptor.share)) {
      for (const entry of descriptor.share) {
        trialTokens.add(entry.token);
        pluginShare.set(entry.id, entry.token);
      }
    }
    const pluginShareEntries = [];
    let assignmentFailed = false;
    for (const layer of descriptor.layers) {
      let token = pluginShare.get(layer.id);
      if (token === undefined) {
        token = nextFreeToken(trialTokens);
        if (token === null) {
          const message = `no free share token available for plugin layer: ${layer.id}`;
          errors.push({ spec, error: message });
          console.error(`[gev plugins] ${descriptor.id}: ${message}`);
          assignmentFailed = true;
          break;
        }
      }
      trialTokens.add(token);
      pluginShareEntries.push({
        id: layer.id,
        token,
        disposition: 'enabled-only',
      });
    }
    if (assignmentFailed) continue;

    for (const layer of descriptor.layers) claimedLayerIds.add(layer.id);
    for (const entry of pluginShareEntries) claimedTokens.add(entry.token);
    for (const entry of pluginShareEntries) shareEntries.push(entry);
    plugins.push(descriptor);
  }

  return { plugins, shareEntries, errors };
}
