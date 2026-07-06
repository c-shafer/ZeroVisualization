import { calibrate } from "./calibration.js";
import { sampleZoneColors, classifyZone } from "./zoneClassifier.js";
import {
  applyOffsetToAimPoint, moaDiameterToPixelRadius, targetZoomFactor, TARGET_SCALE_REFERENCE_RANGE_YD,
} from "./targetMath.js";
import { computeTrajectoryTable, interpolateTrajectory, DRAG_MODELS } from "./ballistics.js";
import { drawFrame } from "./renderer.js";
import { debounce, rafThrottle, clamp } from "./utils.js";

const EXPENSIVE_RECOMPUTE_DEBOUNCE_MS = 120;
const RANGE_MIN_YD = 0;
const RANGE_MAX_YD = 50;

const DEFAULT_ZERO_CONFIG = {
  mvFps: 1150,
  bc: 0.15,
  dragModel: "G1",
  bulletWeightGr: 124,
  sightHeightIn: 1.5,
  zeroDistanceYd: 10,
};

const appState = {
  mode: "impact",
  aimPointPx: { x: 0, y: 0 },
  rangeYd: 10,
  maxRangeYd: RANGE_MAX_YD,
  zeroConfig: { ...DEFAULT_ZERO_CONFIG },
  dotMoa: 2,
  scaleTargetEnabled: false,
  zeroOffsetIn: { elevation: 0, windage: 0 },
  groupEnabled: false,
  groupMoa: 3,
  advancedEnabled: false,
  wind: { speedMph: 0, directionDeg: 0 },
  atmo: { temperatureF: 59, pressureInHg: 29.92, humidityPct: 0, altitudeFt: 0 },
  twistIn: 0,
  lookAngleDeg: 0,
  cantAngleDeg: 0,
  coriolisLatitudeDeg: 0,
  coriolisAzimuthDeg: 0,
  calibration: null,
  zoneColors: null,
  imageData: null,
  image: null,
  trajectoryTable: null,
  requestToken: 0,
  status: "loading",
};

let canvas, ctx;

function getEl(id) {
  return document.getElementById(id);
}

function populateDragModelSelect() {
  const select = getEl("drag-model-select");
  select.innerHTML = "";
  for (const model of DRAG_MODELS) {
    const option = document.createElement("option");
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }
  select.value = appState.zeroConfig.dragModel;
}

function setStatus(status) {
  appState.status = status;
  getEl("status-text").textContent = {
    loading: "Loading…",
    ready: "Ready",
    recomputing: "Recalculating…",
    error: "Calculation error — check console",
  }[status] ?? status;
}

/** Cheap path: pure lookup + redraw, no WASM call. Safe to call at 60fps. */
function cheapRedraw() {
  if (!appState.calibration || !appState.trajectoryTable) return;

  let { dropIn, windageIn } = interpolateTrajectory(appState.trajectoryTable, appState.rangeYd);

  // Zero offset simulates a zeroing error observed at the zero distance (e.g. a windage
  // click mistake) -- it's a fixed angular error, so it scales proportionally with range,
  // same convention as legacy-python-viz's "_w_error" shot data.
  const rangeRatio = appState.rangeYd / appState.zeroConfig.zeroDistanceYd;
  dropIn += appState.zeroOffsetIn.elevation * rangeRatio;
  windageIn += appState.zeroOffsetIn.windage * rangeRatio;

  const markerPx = applyOffsetToAimPoint(
    appState.mode,
    appState.aimPointPx,
    dropIn,
    windageIn,
    appState.calibration
  );
  const zoneLabel = classifyZone(
    appState.imageData,
    markerPx.x,
    markerPx.y,
    appState.calibration,
    appState.zoneColors
  );

  // "Scale target, not dot" mode: keep the reticle/group circle a constant on-screen size
  // (as if always viewed at the reference range) and shrink/grow the target image itself
  // instead, via the zoom factor passed to the renderer.
  const zoom = appState.scaleTargetEnabled ? targetZoomFactor(appState.rangeYd) : 1;
  const sizingRangeYd = appState.scaleTargetEnabled ? TARGET_SCALE_REFERENCE_RANGE_YD : appState.rangeYd;

  const dotRadiusPx = moaDiameterToPixelRadius(appState.dotMoa, sizingRangeYd, appState.calibration);
  const groupRadiusPx = appState.groupEnabled
    ? moaDiameterToPixelRadius(appState.groupMoa, sizingRangeYd, appState.calibration)
    : null;

  drawFrame(ctx, {
    image: appState.image,
    mode: appState.mode,
    aimPointPx: appState.aimPointPx,
    markerPx,
    zoneLabel,
    rangeYd: appState.rangeYd,
    dropIn,
    windageIn,
    status: appState.status,
    dotMoa: appState.dotMoa,
    dotRadiusPx,
    groupMoa: appState.groupMoa,
    groupRadiusPx,
    elevationOffsetIn: appState.zeroOffsetIn.elevation,
    windageOffsetIn: appState.zeroOffsetIn.windage,
    zoom,
    // Zoom is always centered on the current aimpoint, so it stays fixed on screen (like
    // looking through a scope) while the target shrinks/grows and pans underneath it.
    zoomAnchorPx: appState.scaleTargetEnabled ? appState.aimPointPx : null,
  });
}
const throttledRedraw = rafThrottle(cheapRedraw);

/** Expensive path: async WASM re-zero + fire, guarded against out-of-order resolution. */
async function scheduleExpensiveRecompute() {
  appState.requestToken += 1;
  const myToken = appState.requestToken;
  setStatus("recomputing");

  try {
    const table = await computeTrajectoryTable(appState.zeroConfig, {
      maxRangeYd: appState.maxRangeYd,
      advanced: appState.advancedEnabled
        ? {
            windSpeedMph: appState.wind.speedMph,
            windDirectionDeg: appState.wind.directionDeg,
            temperatureF: appState.atmo.temperatureF,
            pressureInHg: appState.atmo.pressureInHg,
            humidityPct: appState.atmo.humidityPct,
            altitudeFt: appState.atmo.altitudeFt,
            twistIn: appState.twistIn,
            lookAngleDeg: appState.lookAngleDeg,
            cantAngleDeg: appState.cantAngleDeg,
            coriolisLatitudeDeg: appState.coriolisLatitudeDeg,
            coriolisAzimuthDeg: appState.coriolisAzimuthDeg,
          }
        : null,
    });
    if (myToken !== appState.requestToken) return; // superseded by a newer request
    appState.trajectoryTable = table;
    setStatus("ready");
  } catch (err) {
    if (myToken !== appState.requestToken) return;
    console.error("Ballistics recompute failed:", err);
    setStatus("error");
  }
  throttledRedraw();
}
const debouncedExpensiveRecompute = debounce(scheduleExpensiveRecompute, EXPENSIVE_RECOMPUTE_DEBOUNCE_MS);

function wireModeToggle() {
  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener("change", (e) => {
      appState.mode = e.target.value;
      throttledRedraw();
    });
  }
}

function wireRangeControls() {
  const slider = getEl("range-slider");
  const valueLabel = getEl("range-value");
  slider.min = RANGE_MIN_YD;
  slider.max = appState.maxRangeYd;
  slider.step = 0.5;
  slider.value = appState.rangeYd;
  valueLabel.textContent = `${appState.rangeYd} yd`;

  slider.addEventListener("input", (e) => {
    appState.rangeYd = parseFloat(e.target.value);
    valueLabel.textContent = `${appState.rangeYd} yd`;
    throttledRedraw();
  });

  for (const btn of document.querySelectorAll(".range-preset")) {
    btn.addEventListener("click", () => {
      const yd = parseFloat(btn.dataset.rangeYd);
      appState.rangeYd = yd;
      slider.value = yd;
      valueLabel.textContent = `${yd} yd`;
      throttledRedraw();
    });
  }
}

function wireZeroConfigControls() {
  const bindings = [
    ["mv-input", "mvFps", parseFloat],
    ["bc-input", "bc", parseFloat],
    ["drag-model-select", "dragModel", (v) => v],
    ["bullet-weight-input", "bulletWeightGr", parseFloat],
    ["sight-height-input", "sightHeightIn", parseFloat],
    ["zero-distance-input", "zeroDistanceYd", parseFloat],
  ];
  for (const [id, key, parse] of bindings) {
    getEl(id).addEventListener("input", (e) => {
      const value = parse(e.target.value);
      if (typeof value === "number" && Number.isNaN(value)) return;
      appState.zeroConfig[key] = value;
      debouncedExpensiveRecompute();
    });
  }
}

function wireReticleControls() {
  getEl("dot-moa-input").addEventListener("input", (e) => {
    const value = parseFloat(e.target.value);
    if (Number.isNaN(value)) return;
    appState.dotMoa = Math.max(0, value);
    throttledRedraw();
  });
  getEl("scale-target-toggle").addEventListener("change", (e) => {
    appState.scaleTargetEnabled = e.target.checked;
    throttledRedraw();
  });
}

function wireZeroOffsetControls() {
  getEl("elevation-offset-input").addEventListener("input", (e) => {
    const value = parseFloat(e.target.value);
    if (Number.isNaN(value)) return;
    appState.zeroOffsetIn.elevation = value;
    throttledRedraw();
  });
  getEl("windage-offset-input").addEventListener("input", (e) => {
    const value = parseFloat(e.target.value);
    if (Number.isNaN(value)) return;
    appState.zeroOffsetIn.windage = value;
    throttledRedraw();
  });
}

function wireGroupControls() {
  getEl("group-toggle").addEventListener("change", (e) => {
    appState.groupEnabled = e.target.checked;
    throttledRedraw();
  });
  getEl("group-moa-input").addEventListener("input", (e) => {
    const value = parseFloat(e.target.value);
    if (Number.isNaN(value)) return;
    appState.groupMoa = Math.max(0.1, value);
    throttledRedraw();
  });
}

function wireAdvancedControls() {
  const advancedFields = getEl("advanced-fields");
  const maxRangeInput = getEl("max-range-input");
  const slider = getEl("range-slider");
  const valueLabel = getEl("range-value");

  function clampRangeToMax(maxYd) {
    slider.max = maxYd;
    if (appState.rangeYd > maxYd) {
      appState.rangeYd = maxYd;
      slider.value = maxYd;
      valueLabel.textContent = `${maxYd} yd`;
      throttledRedraw();
    }
  }

  getEl("advanced-toggle").addEventListener("change", (e) => {
    appState.advancedEnabled = e.target.checked;
    advancedFields.hidden = !appState.advancedEnabled;

    // The controllable max range only applies while advanced options are on -- snap the
    // slider back to the default range otherwise.
    if (!appState.advancedEnabled) {
      appState.maxRangeYd = RANGE_MAX_YD;
      maxRangeInput.value = RANGE_MAX_YD;
      clampRangeToMax(RANGE_MAX_YD);
    }
    debouncedExpensiveRecompute();
  });

  maxRangeInput.addEventListener("input", (e) => {
    const value = parseFloat(e.target.value);
    if (Number.isNaN(value) || value <= RANGE_MIN_YD) return;
    appState.maxRangeYd = value;
    clampRangeToMax(value);
    debouncedExpensiveRecompute();
  });

  const advancedBindings = [
    ["wind-speed-input", (v) => { appState.wind.speedMph = v; }],
    ["wind-direction-input", (v) => { appState.wind.directionDeg = v; }],
    ["temperature-input", (v) => { appState.atmo.temperatureF = v; }],
    ["pressure-input", (v) => { appState.atmo.pressureInHg = v; }],
    ["humidity-input", (v) => { appState.atmo.humidityPct = v; }],
    ["altitude-input", (v) => { appState.atmo.altitudeFt = v; }],
    ["twist-input", (v) => { appState.twistIn = v; }],
    ["look-angle-input", (v) => { appState.lookAngleDeg = v; }],
    ["cant-angle-input", (v) => { appState.cantAngleDeg = v; }],
    ["latitude-input", (v) => { appState.coriolisLatitudeDeg = v; }],
    ["azimuth-input", (v) => { appState.coriolisAzimuthDeg = v; }],
  ];
  for (const [id, setter] of advancedBindings) {
    getEl(id).addEventListener("input", (e) => {
      const value = parseFloat(e.target.value);
      if (Number.isNaN(value)) return;
      setter(value);
      debouncedExpensiveRecompute();
    });
  }
}

/** Raw client (page) coords -> canvas backing-pixel coords, accounting for CSS display scaling. */
function clientToCanvasPx(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: clamp((clientX - rect.left) * scaleX, 0, canvas.width - 1),
    y: clamp((clientY - rect.top) * scaleY, 0, canvas.height - 1),
  };
}

function currentZoom() {
  return appState.scaleTargetEnabled ? targetZoomFactor(appState.rangeYd) : 1;
}

/**
 * Inverts the renderer's zoom transform: canvas backing-pixel coords -> world (native image)
 * pixel coords. In "scale target" mode the view is zoomed and re-centered on the current
 * aimpoint each frame (see cheapRedraw's zoomAnchorPx), so a canvas pixel doesn't map 1:1 to
 * a world pixel like it does at zoom=1 -- this must match toScreen() in renderer.js exactly.
 */
function canvasPxToWorldPx(canvasPx) {
  const zoom = currentZoom();
  if (zoom === 1) return canvasPx; // identity when not zoomed (default mode, or 25yd exactly)
  const anchorScreen = { x: canvas.width / 2, y: canvas.height / 2 };
  return {
    x: clamp(appState.aimPointPx.x + (canvasPx.x - anchorScreen.x) / zoom, 0, canvas.width - 1),
    y: clamp(appState.aimPointPx.y + (canvasPx.y - anchorScreen.y) / zoom, 0, canvas.height - 1),
  };
}

function wireAimPointDragging() {
  let dragging = false;
  let lastCanvasPx = null;

  canvas.addEventListener("pointerdown", (e) => {
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    const canvasPx = clientToCanvasPx(e.clientX, e.clientY);
    // Absolute positioning for the initial click: place the aimpoint at the world point
    // currently under the cursor.
    appState.aimPointPx = canvasPxToWorldPx(canvasPx);
    lastCanvasPx = canvasPx;
    throttledRedraw();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const canvasPx = clientToCanvasPx(e.clientX, e.clientY);
    // Incremental (delta-based) positioning while dragging: the view re-centers on the
    // aimpoint every frame in "scale target" mode, so re-deriving an absolute world position
    // from the cursor's screen position each event (like pointerdown does) would compound
    // with that re-centering and make the aimpoint run away from the cursor. A screen-space
    // delta converted to world units via the (constant, mid-drag) zoom factor avoids that.
    const zoom = currentZoom();
    appState.aimPointPx = {
      x: clamp(appState.aimPointPx.x + (canvasPx.x - lastCanvasPx.x) / zoom, 0, canvas.width - 1),
      y: clamp(appState.aimPointPx.y + (canvasPx.y - lastCanvasPx.y) / zoom, 0, canvas.height - 1),
    };
    lastCanvasPx = canvasPx;
    throttledRedraw();
  });

  canvas.addEventListener("pointerup", () => {
    dragging = false;
    lastCanvasPx = null;
  });
  canvas.addEventListener("pointercancel", () => {
    dragging = false;
    lastCanvasPx = null;
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function init() {
  canvas = getEl("target-canvas");
  ctx = canvas.getContext("2d");

  const image = await loadImage("./assets/target.png");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const offscreen = document.createElement("canvas");
  offscreen.width = image.naturalWidth;
  offscreen.height = image.naturalHeight;
  const offscreenCtx = offscreen.getContext("2d", { willReadFrequently: true });
  offscreenCtx.drawImage(image, 0, 0);
  const imageData = offscreenCtx.getImageData(0, 0, offscreen.width, offscreen.height);

  appState.image = image;
  appState.imageData = imageData;
  appState.calibration = calibrate(imageData);
  appState.zoneColors = sampleZoneColors(imageData);

  // Offset from dead-center: the body A-zone has a large printed "A" glyph in the
  // middle, which would make the default aimpoint immediately read as "Unknown".
  const { bodyBoxPx } = appState.calibration;
  appState.aimPointPx = {
    x: (bodyBoxPx.minX + bodyBoxPx.maxX) / 2,
    y: bodyBoxPx.minY + (bodyBoxPx.maxY - bodyBoxPx.minY) * 0.25,
  };

  populateDragModelSelect();
  wireModeToggle();
  wireRangeControls();
  wireZeroConfigControls();
  wireReticleControls();
  wireZeroOffsetControls();
  wireGroupControls();
  wireAdvancedControls();
  wireAimPointDragging();

  await scheduleExpensiveRecompute();
}

init().catch((err) => {
  console.error("Failed to initialize app:", err);
  setStatus("error");
});
