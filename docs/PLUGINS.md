# Plugins (experimental)

God's Eye View can load third-party data layers at runtime from a manifest, with **no edits to core files**. This is an opt-in, additive prototype; with no manifest the app behaves exactly like before.

## Manifest

Create `gev.plugins.json` at the repo root (gitignored — copy `gev.plugins.example.json`):

```json
{ "plugins": ["./plugins/hello-layer/index.js"] }
```

The client fetches `/gev.plugins.json`. A `404` (no manifest) means **no plugins** and is silent. Entries may be either:

- a **string** — a same-origin relative path (`./` prefix, ending in `.js` or `.mjs`, no `..` segment, no absolute path, no URL scheme) pointing at a plugin that lives inside the repo (typically `./plugins/<name>/index.js`). Vite serves these in dev.
- an **object** — `{ "name": "<name>", "dir": "<absolute directory path>", "entry": "index.js" }` describing a plugin that lives OUTSIDE the repo. `name` must match `/^[a-z0-9-]+$/` and be unique. `dir` must be an absolute path to an existing directory on the operator's machine. `entry` (default `index.js`) is a file name inside that directory, matching `/^[a-z0-9._-]+\.(js|mjs)$/` with no slashes.

Object entries are an operator-owned local choice — the manifest (`gev.plugins.json`) is gitignored. The server (`scripts/plugin-manifest.mjs`, wired through `server/standalone/vite.config.js`) rewrites each object entry to a `./plugins/<name>/<entry>` path before it reaches the browser, so the client never sees an absolute path and the client contract (string entries only) is unchanged. The dev/preview server serves an external plugin's files only from its declared `dir`, through a traversal-safe join that refuses `..`, encoded `%2e%2e`, backslashes, absolute segments, and symlinks pointing outside the dir. Nothing outside a declared dir is ever exposed (this is why no `server.fs.allow` entry is added).

External plugins must be **self-contained ESM**. Use the `Cesium` and `viewer` handed in through `ctx`; do not import bare specifiers (no `import 'cesium'`) — there is no bundler resolution from outside the repo. Relative imports inside the plugin dir are fine (`import './points.js'`), because sibling files are served by the middleware. Served asset extensions are `.js`/`.mjs`, `.json`, `.css`, `.wasm`, `.png`/`.jpg`/`.svg`/`.gif`; any other extension returns a 404.

```json
{
  "plugins": [
    "./plugins/hello-layer/index.js",
    { "name": "ext-demo", "dir": "/Users/me/gev-plugins/ext-demo", "entry": "index.js" }
  ]
}
```

The manifest is re-read on every dev request, so editing `gev.plugins.json` applies without a dev-server restart.

### Production builds

`vite build` copies every referenced plugin into `dist/plugins/...` (root plugins preserving their repo-relative path, external plugins into `dist/plugins/<name>/`) and writes the normalized client manifest to `dist/gev.plugins.json`. `vite preview` then serves the built plugins, so a built/preview app loads the same plugins as dev. With no manifest, the build output is unchanged — no `dist/gev.plugins.json`, no `dist/plugins/`.

## Plugin contract

A plugin module's **default export** is `createPlugin(ctx)` receiving `{ Cesium, viewer, registerDynamicCredit, layerFeedState }` and returning a descriptor. `layerFeedState(stats)` is the pure classifier the control chips use (`nominal | loading | degraded | stale | fallback | unavailable`). A layer that defines `attachDataManager(dataManager)` receives the DataLayerManager once after registration, so it can observe other layers through `dataManager.getAll()` (the same hook the rocket-launches and military-awareness layers use).

```js
{
  id: 'my-plugin',          // /^[a-z0-9-]+$/, unique vs built-in layer ids
  version: '0.1.0',
  name: 'My Plugin',
  layers: [/* layer modules implementing the layer interface */],
  share: [{ id: 'my-layer', token: 'k' }], // optional, one per layer
  credits: [{ key: 'my-layer', html: 'Attribution' }], // optional
}
```

Each `layers[i]` implements the layer interface used by the built-in layer factories (see `src/layers/<family>/index.js`): `id, name, icon, showInTogglePanel` and `init/enable/disable/update/destroy/getStats`; `getDetectableObjects` is optional (enables the detection overlay). Ids must match `/^[a-z0-9-]+$/` and must not collide with existing layer ids. Prefer the `Cesium` handed in via `ctx` over importing `cesium` directly.

## Share tokens

A plugin layer that should round-trip through a share link declares a `share` entry with a single `[a-z0-9]` token. Disposition is always `enabled-only`. Free (unused) layer tokens in the current base registry:

`0 1 2 3 4 5 6 7 8 9 k l o y`

(`v` is reserved — it is the radio volume OPTION token carried in the `lo` param, not a layer token — so plugin layers avoid it to keep the two namespaces unambiguous.) The demo `plugins/hello-layer` plugin uses `k`.

**Auto-assigned tokens.** `share` is optional, but every accepted plugin layer ends up with a token so the catalog metadata stays complete. A layer with no `share` entry gets one **auto-assigned** from the free pool — digits `'0'`-`'9'` first, then letters `'a'`-`'z', skipping every token already claimed by the built-in registry, an earlier plugin, or an explicit token in the same plugin. The loader performs the assignment (so it is covered by the unit tests) and exposes every assigned token in the returned `shareEntries`. Collision with an EXPLICIT token stays a hard rejection of the whole plugin, exactly as before; only un-tokened layers are filled in.

Plugins load before the initial share hash is parsed (the loader runs inside the scene phase in `src/standalone/application.js`, before the controls phase builds the StyleManager), so a link that carries a plugin token restores that layer at boot, provided the same manifest lists the plugin.

## Wiring

The runtime loader is `src/pluginLoader.js` (browser-safe, no `node:*` imports). The standalone wiring lives in `src/standalone/plugins.js` (`installStandalonePlugins`), which is called from `src/standalone/application.js` after the base catalog is built. The server-side manifest helpers and the Vite plugin (`gevPluginsVitePlugin`) live in `scripts/plugin-manifest.mjs` and are attached in `server/standalone/vite.config.js`. None of `src/app/*` is touched.

## Not supported yet

- Voice-tool enum integration.
- Plugin-provided styles or UI panels.

## Try the demo

```bash
cp gev.plugins.example.json gev.plugins.json
npm run dev
```

Enable **Hello Plugin** in the data panel. `window.__godsEyeView.plugins` exposes `{ plugins, shareEntries, errors, assignedTokens }` for inspection (`assignedTokens` maps layer id → token).
