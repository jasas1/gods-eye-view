/**
 * Hello Layer — a minimal demo plugin for the GEV runtime plugin loader.
 *
 * Default export is a `createPlugin(ctx)` factory returning a descriptor with one
 * layer. It is the documented starting point for third-party layer plugins and
 * doubles as the loader's smoke test. See docs/PLUGINS.md for the contract.
 *
 * The layer adds five Cesium point entities (with labels) into a dedicated
 * CustomDataSource, exposes the detectable-object shape the detection paint
 * loop expects, and round-trips through the share-link registry via the token
 * 'p'. It uses the `Cesium` handed in through ctx (no bundler resolution
 * needed from /plugins).
 */

/** Five fixed demo positions around Austin, TX (the default fly-to). */
const POINTS = Object.freeze([
  { id: 'hello-layer:1', lat: 30.2672, lon: -97.7431, label: 'Hello 1' },
  { id: 'hello-layer:2', lat: 30.3000, lon: -97.7300, label: 'Hello 2' },
  { id: 'hello-layer:3', lat: 30.2400, lon: -97.7600, label: 'Hello 3' },
  { id: 'hello-layer:4', lat: 30.2800, lon: -97.7800, label: 'Hello 4' },
  { id: 'hello-layer:5', lat: 30.2600, lon: -97.7100, label: 'Hello 5' },
]);

/**
 * Build the hello layer module against a Cesium namespace + viewer.
 * @param {{ Cesium: object, viewer: object }} ctx
 * @returns {object} A layer module implementing the GEV layer interface.
 */
function createHelloLayer({ Cesium, viewer }) {
  let dataSource = null;
  let positions = [];
  let enabled = false;

  function ensureDataSource() {
    if (dataSource) return dataSource;
    dataSource = new Cesium.CustomDataSource('hello-layer');
    dataSource.show = false;
    viewer.dataSources.add(dataSource);
    return dataSource;
  }

  function addEntities() {
    const ds = ensureDataSource();
    ds.entities.removeAll();
    positions = [];
    for (const p of POINTS) {
      const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
      positions.push(position);
      ds.entities.add({
        id: p.id,
        position,
        point: { pixelSize: 10, color: Cesium.Color.LIME, outlineColor: Cesium.Color.BLACK, outlineWidth: 1 },
        label: { text: p.label, font: '14px sans-serif', fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 2, style: Cesium.LabelStyle.FILL_AND_OUTLINE, pixelOffset: new Cesium.Cartesian2(0, -16) },
      });
    }
  }

  return {
    id: 'hello-layer',
    name: 'Hello Plugin',
    icon: '🧩',
    showInTogglePanel: true,

    init() {
      ensureDataSource();
      enabled = false;
    },

    enable() {
      addEntities();
      if (dataSource) dataSource.show = true;
      enabled = true;
    },

    disable() {
      enabled = false;
      if (dataSource) dataSource.show = false;
      if (dataSource) dataSource.entities.removeAll();
      positions = [];
    },

    update() {
      return Promise.resolve();
    },

    destroy() {
      enabled = false;
      positions = [];
      if (dataSource && viewer) {
        viewer.dataSources.remove(dataSource, true);
        dataSource = null;
      }
    },

    getStats() {
      return { count: enabled ? POINTS.length : 0 };
    },

    /**
     * Return the five points in the shape the detection paint loop expects
     * (mirrors the bikeshare layer's detectable-object shape). Empty unless
     * the layer is enabled.
     */
    getDetectableObjects() {
      if (!enabled || positions.length === 0) return [];
      return POINTS.map((p, i) => ({
        position: positions[i],
        sourceId: p.id,
        id: p.id,
        type: 'VEH',
        skipLabel: false,
      }));
    },
  };
}

/**
 * Plugin factory. GEV's loader imports this module's default export and calls
 * it with `{ Cesium, viewer, registerDynamicCredit }`.
 * @param {{ Cesium: object, viewer: object, registerDynamicCredit?: Function }} ctx
 * @returns {{ id: string, version: string, name: string, layers: object[], share: Array<{ id: string, token: string }>, credits: Array<{ key: string, html: string }> }}
 */
export default function createPlugin({ Cesium, viewer }) {
  return {
    id: 'hello-layer-plugin',
    version: '0.1.0',
    name: 'Hello Layer',
    layers: [createHelloLayer({ Cesium, viewer })],
    share: [{ id: 'hello-layer', token: 'p' }],
    credits: [{ key: 'hello-layer', html: 'Hello Layer demo plugin' }],
  };
}
