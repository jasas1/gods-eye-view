# Plugins (experimental)

God's Eye View can load third-party data layers at runtime from a manifest, with **no edits to core files**. This is an opt-in, additive prototype; with no manifest the app behaves exactly like before.

## Manifest

Create `gev.plugins.json` at the repo root (gitignored — copy `gev.plugins.example.json`):

```json
{ "plugins": ["./plugins/hello-layer/index.js"] }
```

The client fetches `/gev.plugins.json`. A `404` (no manifest) means **no plugins** and is silent. Entries must be same-origin relative paths: a `./` prefix, ending in `.js` or `.mjs`, no `..` segment, no absolute path, no URL scheme — the manifest cannot point off-origin. Vite serves root files and `/plugins/...` modules in dev. **Production `vite build` is out of scope** — runtime plugin loading is a dev/preview feature for now.

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
- Production builds (`vite build`).
- Plugin-provided styles or UI panels.

## Try the demo

```bash
cp gev.plugins.example.json gev.plugins.json
npm run dev
```

Enable **Hello Plugin** in the data panel. `window.__godsEyeView.plugins` exposes `{ plugins, shareEntries, errors }` for inspection.
