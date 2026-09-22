/**
 * Server-side plugin manifest helpers for God's Eye View.
 *
 * The runtime plugin loader (src/pluginLoader.js) is browser-safe and only
 * accepts same-origin `./`-prefixed module specifiers. This module is the
 * server-side companion that lets an operator point a manifest at plugins
 * that live OUTSIDE the repo, while never exposing anything beyond a
 * declared plugin directory. It normalizes the operator manifest into a
 * client-facing manifest (only `./plugins/<name>/<entry>` paths, never
 * absolute paths), serves external plugin files through a traversal-safe
 * join, and copies every referenced plugin into the build output so
 * `vite build` / `vite preview` work too.
 *
 * This module is Node-only (`node:*` imports) and never reaches the browser
 * bundle: it lives under scripts/ (like pinokio-environment.mjs) and is only
 * imported by vite.config.js. The browser boundary test (src/*.js) does not
 * scan scripts/.
 *
 * Manifest format v2 (backwards compatible with the v1 string-only form):
 *   { "plugins": [ "./plugins/hello-layer/index.js",
 *                 { "name": "ext-demo", "dir": "/abs/path", "entry": "index.js" } ] }
 *
 * @module scripts/plugin-manifest
 */

import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Plugin/entry name grammar — same rule as the layer-state registry. */
const NAME_RE = /^[a-z0-9-]+$/;
/** Entry file name grammar — flat file inside a plugin dir, .js or .mjs. */
const ENTRY_RE = /^[a-z0-9._-]+\.(js|mjs)$/;
/** File extensions the middleware will serve for external plugins. */
const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
};

/**
 * Decide whether a root (string) manifest entry is an allowed same-origin
 * plugin path. Mirrors the client's `isAllowedPluginPath` rule exactly so the
 * client contract never changes: a `./` prefix, ending in `.js` or `.mjs`, no
 * `..` segment, no scheme, no empty segments.
 *
 * @param {string} spec - Candidate module specifier from the manifest.
 * @returns {boolean}
 */
function isAllowedRootPluginPath(spec) {
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
 * Normalize a parsed manifest object into a server view + a client-facing
 * manifest. Bad entries do not reject the good ones (same isolation contract
 * as the client loader).
 *
 * Root (string) entries pass through unchanged to `rootEntries` and the
 * client manifest, keeping the existing client rules. Object entries
 * describe a plugin living OUTSIDE the repo and are rewritten to
 * `./plugins/<name>/<entry>` for the client (so the client never sees an
 * absolute path).
 *
 * @param {unknown} json - The parsed manifest.
 * @param {{ root: string }} _options - Repo root (reserved; absolute external
 *   dirs are validated directly, so `root` is not currently used for
 *   resolution — kept on the signature for symmetry with readPluginManifest).
 * @returns {{
 *   rootEntries: string[],
 *   externals: { name: string, dir: string, entry: string }[],
 *   clientManifest: { plugins: string[] },
 *   errors: string[],
 * }}
 */
export function normalizePluginManifest(json, { root } = {}) {
  void root; // reserved for future relative-dir resolution; absolute dirs are validated as-is
  const rootEntries = [];
  const externals = [];
  const clientManifest = { plugins: [] };
  const errors = [];
  const names = new Set();

  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    errors.push('manifest must be an object with a "plugins" array');
    return { rootEntries, externals, clientManifest, errors };
  }
  const raw = json.plugins;
  if (!Array.isArray(raw)) {
    errors.push('manifest "plugins" must be an array');
    return { rootEntries, externals, clientManifest, errors };
  }

  for (const entry of raw) {
    if (typeof entry === 'string') {
      if (!isAllowedRootPluginPath(entry)) {
        errors.push(
          `manifest entry rejected (must be a relative ./*.js|.mjs path with no ".."): ${entry}`,
        );
        continue;
      }
      rootEntries.push(entry);
      clientManifest.plugins.push(entry);
      continue;
    }

    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const name = entry.name;
      const dir = entry.dir;
      const entryName = entry.entry !== undefined ? entry.entry : 'index.js';

      if (typeof name !== 'string' || !NAME_RE.test(name)) {
        errors.push(
          `plugin entry name must match /^[a-z0-9-]+$: ${String(name)}`,
        );
        continue;
      }
      if (names.has(name)) {
        errors.push(`plugin entry name duplicated: ${name}`);
        continue;
      }
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
        errors.push(
          `plugin entry dir must be an absolute path: ${String(dir)}`,
        );
        continue;
      }
      let dirStat;
      try {
        dirStat = statSync(dir);
      } catch {
        dirStat = null;
      }
      if (!dirStat || !dirStat.isDirectory()) {
        errors.push(
          `plugin entry dir does not exist or is not a directory: ${dir}`,
        );
        continue;
      }
      if (
        typeof entryName !== 'string' ||
        entryName.length === 0 ||
        entryName.includes('/') ||
        entryName.includes('\\') ||
        !ENTRY_RE.test(entryName)
      ) {
        errors.push(
          `plugin entry must match /^[a-z0-9._-]+\\.(js|mjs)$/ with no slashes: ${String(entryName)}`,
        );
        continue;
      }
      names.add(name);
      externals.push({ name, dir, entry: entryName });
      clientManifest.plugins.push(`./plugins/${name}/${entryName}`);
      continue;
    }

    errors.push(`manifest entry must be a string or object: ${String(entry)}`);
  }

  return { rootEntries, externals, clientManifest, errors };
}

/**
 * Resolve a plugin-relative file path inside `dir` and return its real
 * (symlink-resolved) absolute path, or `null` when the result escapes `dir`
 * or cannot be resolved.
 *
 * Defenses: percent-decoding (so an encoded `%2e%2e` traversal is caught),
 * backslash-to-forward normalization, rejection of absolute segments and
 * `..` segments, and a final `fs.realpathSync` on both the directory and the
 * resolved target so a symlink that points outside `dir` is rejected.
 *
 * @param {string} dir - Absolute plugin directory (already validated to exist).
 * @param {string} relativePath - File path as received from the URL
 *   (may be percent-encoded; may contain `..`, backslashes, etc.).
 * @returns {string|null} Real absolute path inside `dir`, or null.
 */
export function safeJoinInside(dir, relativePath) {
  if (typeof dir !== 'string' || dir.length === 0) return null;
  if (typeof relativePath !== 'string' || relativePath.length === 0)
    return null;

  let decoded;
  try {
    decoded = decodeURIComponent(relativePath);
  } catch {
    return null;
  }
  // Normalize backslashes (Windows / hostile input) to forward slashes.
  const normalized = decoded.replace(/\\/g, '/');

  // Reject absolute paths: leading '/', drive letters (C:\), and UNC (//).
  if (normalized.startsWith('/')) return null;
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) return null;
  if (normalized.startsWith('//')) return null;

  // Reject any parent-traversal segment and any empty segment.
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (segment === '..' || segment === '') return null;
  }

  const candidate = path.resolve(dir, normalized);

  let dirReal;
  let targetReal;
  try {
    dirReal = realpathSync(dir);
  } catch {
    return null;
  }
  try {
    targetReal = realpathSync(candidate);
  } catch {
    return null;
  }

  if (targetReal === dirReal) return null; // the dir itself is not a servable file
  const prefix = dirReal.endsWith(path.sep) ? dirReal : dirReal + path.sep;
  if (!targetReal.startsWith(prefix)) return null; // escaped the dir (e.g. via symlink)
  return targetReal;
}

/**
 * Read and normalize `<root>/gev.plugins.json`. Absent file = silent `null`
 * (the "no plugins" signal). A malformed (unparseable) file emits exactly one
 * `[gev plugins]` warning and returns an empty result with errors. A
 * parseable file with bad entries emits one warning per error.
 *
 * @param {string} root - Repo root containing `gev.plugins.json`.
 * @returns {object|null} The normalized manifest, or null when absent.
 */
export function readPluginManifest(root) {
  const file = path.join(root, 'gev.plugins.json');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null; // absent = silent, no plugins
    // Any other read error is also treated as "no manifest present" so a dev
    // session never hard-fails on a transiently unreadable local file.
    return null;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    console.warn(
      `[gev plugins] malformed manifest JSON: ${err && err.message ? err.message : err}`,
    );
    return {
      rootEntries: [],
      externals: [],
      clientManifest: { plugins: [] },
      errors: ['malformed manifest JSON'],
    };
  }

  const normalized = normalizePluginManifest(json, { root });
  for (const message of normalized.errors) {
    console.warn(`[gev plugins] ${message}`);
  }
  return normalized;
}

/**
 * Content type for a served plugin asset, or null for an extension the
 * middleware refuses to serve.
 *
 * @param {string} filePath - Absolute file path.
 * @returns {string|null}
 */
function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || null;
}

/**
 * Build the Connect-style request handler that serves the normalized manifest
 * and external plugin files. Root plugins under `<root>/plugins` are NOT
 * served here — Vite's own file server handles them.
 *
 * @param {string} root - Repo root (the manifest is re-read on every request
 *   so edits apply without a dev-server restart).
 * @returns {(req: import('http').IncomingMessage, res: import('http').ServerResponse, next: Function) => void}
 */
export function createPluginRequestHandler(root) {
  function notFound(res) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('Not Found');
  }

  return function handler(req, res, next) {
    if (req.method !== 'GET') return next();
    const rawPath = String(req.url || '').split('?')[0];

    // /gev.plugins.json -> the normalized client manifest (no absolute paths).
    if (rawPath === '/gev.plugins.json') {
      const manifest = readPluginManifest(root);
      if (!manifest) return next(); // absent -> let SPA fallback mean "no manifest"
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(manifest.clientManifest));
      return;
    }

    // /plugins/<name>/<file> for EXTERNAL plugins only.
    const match = /^\/plugins\/([^/]+)\/(.+)$/.exec(rawPath);
    if (!match) return next();
    const name = match[1];
    const file = match[2];

    const manifest = readPluginManifest(root);
    if (!manifest) return next();
    const external = manifest.externals.find((e) => e.name === name);
    if (!external) return next(); // root plugin or unknown -> Vite / SPA handles it

    const resolved = safeJoinInside(external.dir, file);
    if (!resolved) return notFound(res);
    const type = contentTypeFor(resolved);
    if (!type) return notFound(res);
    let body;
    try {
      body = readFileSync(resolved);
    } catch {
      return notFound(res);
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  };
}

/**
 * Recursively copy a plugin directory into a destination, copying regular
 * files only (symlinks are skipped so a link pointing outside the dir can
 * never leak a file), and skipping `node_modules` and dotfile entries.
 *
 * @param {string} src - Absolute source directory (must exist).
 * @param {string} dest - Absolute destination directory (created if missing).
 */
function copyPluginDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyPluginDir(srcPath, destPath);
    } else if (entry.isFile() && !entry.isSymbolicLink()) {
      copyFileSync(srcPath, destPath);
    }
    // Symlinks and other special types are skipped on purpose.
  }
}

/**
 * Copy every referenced plugin into `<outDir>/plugins/...` and write the
 * client manifest to `<outDir>/gev.plugins.json`. With no manifest this does
 * nothing (build output is byte-for-byte unchanged).
 *
 * Root (string) entries are copied preserving their path relative to the
 * repo root (e.g. `./plugins/hello-layer/index.js` -> the parent dir
 * `plugins/hello-layer` is copied to `<outDir>/plugins/hello-layer`), which
 * keeps the on-disk layout consistent with the client manifest string.
 * External (object) entries are copied from their declared `dir` into
 * `<outDir>/plugins/<name>`.
 *
 * @param {string} root - Repo root.
 * @param {string} outDir - Resolved build output directory.
 */
function buildCopyPlugins(root, outDir) {
  const manifest = readPluginManifest(root);
  if (!manifest) return;

  for (const entry of manifest.rootEntries) {
    const relDir = path.dirname(entry); // e.g. ./plugins/hello-layer
    const srcDir = path.resolve(root, relDir);
    const destDir = path.resolve(outDir, relDir);
    let srcStat;
    try {
      srcStat = statSync(srcDir);
    } catch {
      srcStat = null;
    }
    if (!srcStat || !srcStat.isDirectory()) {
      console.warn(
        `[gev plugins] root plugin directory not found, skipped: ${srcDir}`,
      );
      continue;
    }
    copyPluginDir(srcDir, destDir);
    console.log(
      `[gev plugins] copied root plugin ${relDir} -> ${path.relative(outDir, destDir)}`,
    );
  }

  for (const external of manifest.externals) {
    const destDir = path.join(outDir, 'plugins', external.name);
    copyPluginDir(external.dir, destDir);
    console.log(
      `[gev plugins] copied external plugin ${external.name} -> plugins/${external.name}`,
    );
  }

  const manifestDest = path.join(outDir, 'gev.plugins.json');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(manifestDest, JSON.stringify(manifest.clientManifest));
  console.log('[gev plugins] wrote dist manifest');
}

/**
 * Vite plugin that wires the plugin manifest into the dev/preview servers
 * and the build. Add it to the `plugins: [...]` array in vite.config.js.
 *
 * - `configureServer` / `configurePreviewServer`: register the middleware
 *   that serves `/gev.plugins.json` and external `/plugins/<name>/<file>`
 *   assets. Root plugins under `<root>/plugins` are served by Vite itself.
 * - `closeBundle` (build only): copy every referenced plugin into
 *   `<outDir>/plugins/...` and write `<outDir>/gev.plugins.json`.
 *
 * No manifest = no behavior change in dev or build.
 *
 * @returns {import('vite').Plugin}
 */
export function gevPluginsVitePlugin() {
  let resolvedRoot = null;
  let outDir = 'dist';
  return {
    name: 'gev-plugins',
    apply: () => true, // serve + build
    configResolved(config) {
      resolvedRoot = config.root;
      outDir = path.resolve(config.root, config.build.outDir || 'dist');
    },
    configureServer(server) {
      server.middlewares.use(createPluginRequestHandler(server.config.root));
    },
    configurePreviewServer(server) {
      server.middlewares.use(createPluginRequestHandler(server.config.root));
    },
    closeBundle() {
      if (!resolvedRoot) return;
      buildCopyPlugins(resolvedRoot, outDir);
    },
  };
}
