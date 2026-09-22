import { createStandaloneCatalog } from './catalog.js';
import { createStandalonePlaceSearch } from './placeSearch.js';
import { CITY_POIS } from '../locations.js';
import { createApplication } from '../app/application.js';
import { createStandaloneScene } from './scene.js';
import { createStandaloneControls } from './controls.js';
import { createStandaloneData } from './data.js';
import { createStandaloneTools } from './tools.js';
import { installStandalonePlugins } from './plugins.js';
import * as Cesium from 'cesium';

// The existing controls and layer catalog contain page-scoped state.
let constructed = false;

/** Compose the standalone application once per page. Reload to start again. */
export function createStandaloneApplication({
  googleApiKey,
  cesiumToken,
  geospatial = {},
  voice = {},
  allowQaRegistration = false,
}) {
  if (constructed)
    throw new Error('The standalone application already owns this page');
  constructed = true;
  const loadingScreen = document.getElementById('loading-screen');
  const loaderStatus = loadingScreen.querySelector('.loader-status');
  let placeSearch;
  let catalog;
  // Plugin load result (kept on the closure so createTools can expose it on
  // window.__godsEyeView.plugins for the QA probe).
  let plugins;
  return createApplication({
    createScene: async (context) => {
      placeSearch = createStandalonePlaceSearch({
        // The bundled city and landmark data the offline name provider reads.
        // The search package takes it as plain data rather than importing it,
        // so it stays free of application state.
        presets: CITY_POIS,
        ...geospatial,
        resolveApiKey: () => googleApiKey,
        signal: context.signal,
      });
      const scene = await createStandaloneScene({
        ...context,
        googleApiKey,
        cesiumToken,
        loaderStatus,
      });
      catalog = createStandaloneCatalog({
        nepalBoundaryResolver: (signal) =>
          scene.operations.annotationResolver.resolveRegionRingForQuery(
            'Nepal',
            signal,
            placeSearch,
          ),
        signal: context.signal,
        surface: scene.operations.surface,
      });
      // Runtime plugins extend the catalog before the StyleManager parses the
      // initial share hash (controls phase) and before the data manager seals
      // (data phase). The viewer is on the scene object createApplicationScene
      // returns ({ viewer, mapStackController, operations }). With no manifest
      // the catalog is returned untouched.
      ({ catalog, loaded: plugins } = await installStandalonePlugins({
        catalog,
        viewer: scene.viewer,
        Cesium,
      }));
      return scene;
    },
    createControls: (context) =>
      createStandaloneControls({
        ...context,
        loaderStatus,
        placeSearch,
        catalog,
      }),
    createData: (context) =>
      createStandaloneData({ ...context, allowQaRegistration, catalog }),
    createTools: (context) => {
      const tools = createStandaloneTools({
        ...context,
        loadingScreen,
        placeSearch,
        voice,
      });
      // Expose the plugin load result for debugging / the QA probe, which
      // reads `__godsEyeView.plugins.errors`. Set only when the global exists
      // (createStandaloneTools creates it during the tools phase).
      if (typeof window !== 'undefined' && window.__godsEyeView) {
        window.__godsEyeView.plugins = plugins;
      }
      return tools;
    },
  });
}
