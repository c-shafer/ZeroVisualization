// Direct port of the pixel math in legacy-python-viz/map_hits.py (see the "impact"/"holdover"
// branches near the bottom of main()). Image y grows downward; drop/windage are in the
// +up / +right inches convention used throughout that script and its shot CSVs.

export const MOA_IN_PER_100YD = 1.047;

/**
 * Converts an angular size in MOA (e.g. a red-dot reticle diameter, or an expected group
 * diameter) to a pixel radius at a given range, matching legacy-python-viz/map_hits.py's
 * moa_radius_px(). MOA is angular, so the same MOA value covers more inches -- and more
 * pixels -- as range increases.
 *
 * @param {number} moaDiameter
 * @param {number} rangeYd
 * @param {{scaleXInPerPx:number, scaleYInPerPx:number}} calibration
 * @returns {{rx:number, ry:number}}
 */
export function moaDiameterToPixelRadius(moaDiameter, rangeYd, calibration) {
  const radiusIn = (moaDiameter / 2) * rangeYd * MOA_IN_PER_100YD / 100;
  return {
    rx: radiusIn / calibration.scaleXInPerPx,
    ry: radiusIn / calibration.scaleYInPerPx,
  };
}

// Reference range for "scale target, not dot" mode: the target renders at its normal
// (unscaled) size at this range, shrinking/growing relative to it as the selected range
// moves farther/closer -- like looking through a fixed-power scope, where the reticle
// stays a constant apparent size and the target itself appears to shrink with distance.
export const TARGET_SCALE_REFERENCE_RANGE_YD = 25;
const TARGET_ZOOM_MIN = 0.15;
const TARGET_ZOOM_MAX = 4;

/**
 * Returns the target image scale factor for "scale target, not dot" mode. 1 = normal size
 * (at the reference range); < 1 shrinks the target (farther than reference); > 1 grows it
 * (closer than reference). Clamped so extreme range-slider values don't zoom the target
 * into an unusable close-up or a vanishing speck.
 */
export function targetZoomFactor(rangeYd, referenceRangeYd = TARGET_SCALE_REFERENCE_RANGE_YD) {
  const safeRangeYd = Math.max(rangeYd, 1);
  const k = referenceRangeYd / safeRangeYd;
  return Math.min(TARGET_ZOOM_MAX, Math.max(TARGET_ZOOM_MIN, k));
}

/**
 * @param {'impact'|'holdover'} mode
 * @param {{x:number,y:number}} aimPointPx - where you aim (impact) or want the shot to land (holdover)
 * @param {number} dropIn - vertical offset in inches, +up
 * @param {number} windageIn - horizontal offset in inches, +right
 * @param {{scaleXInPerPx:number, scaleYInPerPx:number}} calibration
 * @returns {{x:number,y:number}} the resulting marker's pixel position
 */
export function applyOffsetToAimPoint(mode, aimPointPx, dropIn, windageIn, calibration) {
  const dxPx = windageIn / calibration.scaleXInPerPx;
  const dyPx = dropIn / calibration.scaleYInPerPx;

  if (mode === "impact") {
    // Point of impact given you aim at aimPointPx.
    return { x: aimPointPx.x + dxPx, y: aimPointPx.y - dyPx };
  }
  // Holdover: invert the offset to find where to aim instead, so the shot lands on aimPointPx.
  return { x: aimPointPx.x - dxPx, y: aimPointPx.y + dyPx };
}
