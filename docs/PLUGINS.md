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

Object entries are an operator-owned local choice — the manifest (`gev.plugins.json`) is gitignored. The server rewrites each object entry to a `./plugins/<name>/<entry>` path before it reaches the browser, so the client never sees an absolute path and the client contract (string entries only) is unchanged. The dev/preview server serves an external plugin's files only from its declared `dir`, through a traversal-safe join that refuses `..`, encoded `%2e%2e`, backslashes, absolute segments, and symlinks pointing outside the dir. Nothing outside a declared dir is ever exposed (this is why no `server.fs.allow` entry is added).

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

A plugin module's **default export** is `createPlugin(ctx)` receiving `{ Cesium, viewer, registerDynamicCredit }` and returning a descriptor:

```js
{
  id: 'my-plugin',          // /^[a-z0-9-]+$/, unique vs built-in layer ids
  version: '0.1.0',
  name: 'My Plugin',
  layers: [/* layer modules implementing the layer interface */],
  share: [{ id: 'my-layer', token: 'p' }], // optional, one per layer
  credits: [{ key: 'my-layer', html: 'Attribution' }], // optional
}
```

Each `layers[i]` implements the same interface as `src/data/earthquakes.js`: `id, name, icon, showInTogglePanel` and `init/enable/disable/update/destroy/getStats`; `getDetectableObjects` is optional (enables the detection overlay). Ids must match `/^[a-z0-9-]+$/` and must not collide with existing layer ids. Prefer the `Cesium` handed in via `ctx` over importing `cesium` directly.

## Share tokens

A plugin layer that should round-trip through a share link declares a `share` entry with a single `[a-z0-9]` token. Disposition is always `enabled-only`. Free (unused) tokens today:

`0 1 2 3 4 5 6 7 8 9 h j k l n o p v y z`

Token collisions (with built-ins or other plugins) are rejected at load time. A plugin layer with no `share` entry is simply not serialized into the URL.

Plugins load before the initial share hash is parsed, so a link that carries a plugin token restores that layer at boot, provided the same manifest lists the plugin.

## Not supported yet

- Voice-tool enum integration.
- Plugin-provided styles or UI panels.

## Try the demo

```bash
cp gev.plugins.example.json gev.plugins.json
npm run dev
```

Enable **Hello Plugin** in the data panel. `window.__godsEyeView.plugins` exposes `{ plugins, shareEntries, errors }` for inspection.
