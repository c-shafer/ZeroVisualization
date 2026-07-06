import { colorDistance1Norm } from "./utils.js";

// USPSA target.png is fixed for this app, so its calibration reference points
// are hardcoded constants rather than user-configurable inputs.
//
// Body seed/size matches the value already used in legacy-python-viz/regenerate_assets.py.
// Head seed (969,310) intentionally differs from the legacy aim-point (969,372): that point
// sits on a 1px text/line boundary and flood-fills to a degenerate ~18x1px box. (969,310) was
// verified to reliably bound the full head A-zone box (~346x173px).
export const BODY_SEED_PX = { x: 970, y: 1200 };
export const BODY_REF_WIDTH_IN = 6;
export const BODY_REF_HEIGHT_IN = 11;
export const HEAD_SEED_PX = { x: 969, y: 310 };
export const COLOR_THRESHOLD = 30;

const MIN_PLAUSIBLE_BOX_PX = 20;

function floodFillBBox(imageData, seedX, seedY, threshold) {
  const { width, height, data } = imageData;
  const seedIndex = seedY * width + seedX;
  const seedPxIndex = seedIndex * 4;
  const seedColor = [data[seedPxIndex], data[seedPxIndex + 1], data[seedPxIndex + 2]];

  const visited = new Uint8Array(width * height);
  visited[seedIndex] = 1;
  const queue = [seedIndex];
  let qHead = 0;

  let minX = width, minY = height, maxX = -1, maxY = -1;

  while (qHead < queue.length) {
    const idx = queue[qHead++];
    const x = idx % width;
    const y = (idx / width) | 0;

    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;

    const neighborIdxs = [];
    if (x > 0) neighborIdxs.push(idx - 1);
    if (x < width - 1) neighborIdxs.push(idx + 1);
    if (y > 0) neighborIdxs.push(idx - width);
    if (y < height - 1) neighborIdxs.push(idx + width);

    for (const nIdx of neighborIdxs) {
      if (visited[nIdx]) continue;
      const nPxIndex = nIdx * 4;
      const dist = colorDistance1Norm(
        [data[nPxIndex], data[nPxIndex + 1], data[nPxIndex + 2]],
        seedColor
      );
      if (dist <= threshold) {
        visited[nIdx] = 1;
        queue.push(nIdx);
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    throw new Error(
      `Flood fill from (${seedX},${seedY}) did not select any region.`
    );
  }

  return {
    minX, minY, maxX, maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function assertPlausibleBox(box, label, imageWidth, imageHeight) {
  if (
    box.width < MIN_PLAUSIBLE_BOX_PX ||
    box.height < MIN_PLAUSIBLE_BOX_PX ||
    box.width >= imageWidth ||
    box.height >= imageHeight
  ) {
    throw new Error(
      `Calibration failed: ${label} bounding box (${box.width}x${box.height}px) looks implausible. ` +
      `Check the target image and reference points in calibration.js.`
    );
  }
}

/**
 * Runs the flood-fill calibration once against the loaded target ImageData.
 * Returns inches-per-pixel scale plus the body/head bounding boxes (used later
 * for scoring-zone disambiguation, since the A-zone and D-zone/neck colors repeat
 * in both the head and body regions of this target).
 */
export function calibrate(imageData) {
  const bodyBoxPx = floodFillBBox(imageData, BODY_SEED_PX.x, BODY_SEED_PX.y, COLOR_THRESHOLD);
  assertPlausibleBox(bodyBoxPx, "body A-zone", imageData.width, imageData.height);

  const headBoxPx = floodFillBBox(imageData, HEAD_SEED_PX.x, HEAD_SEED_PX.y, COLOR_THRESHOLD);
  assertPlausibleBox(headBoxPx, "head A-zone", imageData.width, imageData.height);

  const scaleXInPerPx = BODY_REF_WIDTH_IN / bodyBoxPx.width;
  const scaleYInPerPx = BODY_REF_HEIGHT_IN / bodyBoxPx.height;

  return { scaleXInPerPx, scaleYInPerPx, bodyBoxPx, headBoxPx };
}
