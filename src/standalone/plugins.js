import { loadPlugins } from '../pluginLoader.js';
import { createLayerCatalog } from '../app/catalog.js';
import { extendLayerStateRegistry } from '../data/layerState.js';
import { registerDynamicCredit } from '../data/dataCredits.js';
import { registerDetectionLayer } from '../data/detection.js';
import { layerFeedState } from '../data/feedState.js';

/**
 * Load runtime plugins for the standalone application and fold them into the
 * layer catalog before the data manager is sealed.
 *
 * This is the standalone wiring point for the runtime plugin loader
 * (src/pluginLoader.js): it owns the Cesium/viewer context the loader hands to
 * every `createPlugin`, extends the layer-state registry with the plugins'
 * share-token entries so plugin layers round-trip through the share URL, and
 * rebuilds the catalog so `createApplicationData` registers the plugin layers
 * exactly like built-ins. It is the moral equivalent of the plugin-loading
 * block that used to live in src/main.js, moved behind the standalone
 * composition boundary so src/app/* stays untouched.
 *
 * Browser-safe: no `node:*` imports. `Cesium` is passed in by the caller (the
 * standalone application already imports it) so this module never depends on
 * the cesium package directly.
 *
 * @param {object} options
 * @param {object} options.catalog - The standalone layer catalog
 *   ({ layers, metadata, get, … }) produced by `createStandaloneCatalog`.
 * @param {object} options.viewer - The Cesium viewer (handed to plugins).
 * @param {object} options.Cesium - The Cesium namespace (handed to plugins).
 * @param {string} [options.manifestUrl='/gev.plugins.json'] - Manifest URL.
 * @returns {Promise<{ catalog: object, loaded: object }>} `catalog` is the
 *   (possibly rebuilt) catalog; `loaded` is the loader result plus
 *   `assignedTokens` ({ layerId: token }). With no manifest the original
 *   catalog is returned untouched and `loaded` carries empty arrays.
 */
export async function installStandalonePlugins({
  catalog,
  viewer,
  Cesium,
  manifestUrl,
} = {}) {
  if (!catalog?.layers || !catalog?.metadata) {
    throw new TypeError('An application layer catalog is required');
  }

  const loaded = await loadPlugins({
    manifestUrl,
    ctx: {
      Cesium,
      viewer,
      registerDynamicCredit: (credit) => registerDynamicCredit(viewer, credit),
      layerFeedState,
    },
    existingLayerIds: catalog.layers.map((layer) => layer.id),
    existingTokens: catalog.metadata.map((entry) => entry.token),
  });

  // No accepted plugins (no manifest, or every entry failed): leave the
  // catalog untouched. Errors are still surfaced on the loaded handle so the
  // QA probe (`__godsEyeView.plugins.errors`) can see a broken entry.
  if (!loaded.plugins.length) {
    return {
      catalog,
      loaded: {
        plugins: [],
        shareEntries: [],
        errors: loaded.errors,
        assignedTokens: {},
      },
    };
  }

  // Register detection + credits for the accepted plugin layers, mirroring
  // the wiring that used to live in src/main.js.
  const pluginLayers = [];
  for (const descriptor of loaded.plugins) {
    for (const layer of descriptor.layers) {
      pluginLayers.push(layer);
      if (typeof layer.getDetectableObjects === 'function') {
        registerDetectionLayer(layer);
      }
    }
    if (Array.isArray(descriptor.credits)) {
      for (const credit of descriptor.credits) {
        registerDynamicCredit(viewer, credit);
      }
    }
  }

  // Extend the active layer-state registry with the plugins' share entries
  // (one per accepted layer, explicit or auto-assigned) so plugin layers
  // round-trip through the share URL exactly like built-in 'enabled-only'
  // layers. This must run before the StyleManager parses the initial share
  // hash, which is why installStandalonePlugins is called inside createScene.
  const extendedRegistry = extendLayerStateRegistry(loaded.shareEntries);

  // Rebuild the catalog so createApplicationData registers the plugin layers
  // and seals the data manager against the extended metadata. The original
  // standalone catalog may carry extra handles (militaryRegistry, surface);
  // preserve them by spreading the base catalog under the rebuilt one.
  const combined = createLayerCatalog(
    [...catalog.layers, ...pluginLayers],
    extendedRegistry,
  );
  const nextCatalog = Object.freeze({ ...catalog, ...combined });

  const assignedTokens = Object.fromEntries(
    loaded.shareEntries.map((entry) => [entry.id, entry.token]),
  );

  return {
    catalog: nextCatalog,
    loaded: {
      plugins: loaded.plugins,
      shareEntries: loaded.shareEntries,
      errors: loaded.errors,
      assignedTokens,
    },
  };
}
