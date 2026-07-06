import { colorDistance1Norm } from "./utils.js";
import { BODY_SEED_PX } from "./calibration.js";

// Reference points used to sample each zone's live color from the loaded image
// (not hardcoded literals) so classification stays correct if target.png is
// ever regenerated with slightly different tones.
const BACKGROUND_SEED_PX = { x: 10, y: 10 };
const C_ZONE_SEED_PX = { x: 700, y: 1250 };
const D_ZONE_SEED_PX = { x: 970, y: 2500 };

const NEIGHBORHOOD_RADIUS = 2; // 5x5 sample window
const UNKNOWN_DISTANCE_CEILING = 70;

function samplePixel(imageData, x, y) {
  const idx = (y * imageData.width + x) * 4;
  return [imageData.data[idx], imageData.data[idx + 1], imageData.data[idx + 2]];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Samples a small neighborhood and returns the per-channel median color,
 * avoiding misclassification when a single pixel lands on thin printed text/lines. */
function sampleNeighborhoodColor(imageData, px, py) {
  const { width, height } = imageData;
  const rs = [], gs = [], bs = [];
  for (let dy = -NEIGHBORHOOD_RADIUS; dy <= NEIGHBORHOOD_RADIUS; dy++) {
    for (let dx = -NEIGHBORHOOD_RADIUS; dx <= NEIGHBORHOOD_RADIUS; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const [r, g, b] = samplePixel(imageData, x, y);
      rs.push(r); gs.push(g); bs.push(b);
    }
  }
  return [median(rs), median(gs), median(bs)];
}

export function sampleZoneColors(imageData) {
  return {
    background: samplePixel(imageData, BACKGROUND_SEED_PX.x, BACKGROUND_SEED_PX.y),
    aZone: samplePixel(imageData, BODY_SEED_PX.x, BODY_SEED_PX.y),
    cZone: samplePixel(imageData, C_ZONE_SEED_PX.x, C_ZONE_SEED_PX.y),
    dZone: samplePixel(imageData, D_ZONE_SEED_PX.x, D_ZONE_SEED_PX.y),
  };
}

function isInsideBox(px, py, box) {
  return px >= box.minX && px <= box.maxX && py >= box.minY && py <= box.maxY;
}

/**
 * Classifies a target-image pixel point into a USPSA scoring zone label.
 *
 * The A-zone color is shared by both the head and body A-zones, and the D-zone
 * color is shared by the D-ring and the neck, on this target -- so color alone
 * can't distinguish them. Disambiguation uses the calibrated head/body bounding
 * boxes instead of hand-drawn polygons.
 */
export function classifyZone(imageData, px, py, calibration, zoneColors) {
  const { width, height } = imageData;
  if (px < 0 || px >= width || py < 0 || py >= height) return "Off target";

  const color = sampleNeighborhoodColor(imageData, Math.round(px), Math.round(py));

  const candidates = [
    ["background", zoneColors.background],
    ["aZone", zoneColors.aZone],
    ["cZone", zoneColors.cZone],
    ["dZone", zoneColors.dZone],
  ];

  let bestLabel = null;
  let bestDist = Infinity;
  for (const [label, refColor] of candidates) {
    const dist = colorDistance1Norm(color, refColor);
    if (dist < bestDist) {
      bestDist = dist;
      bestLabel = label;
    }
  }

  if (bestDist > UNKNOWN_DISTANCE_CEILING) return "Unknown (line/text)";

  switch (bestLabel) {
    case "background":
      return "Miss";
    case "cZone":
      return "C";
    case "aZone":
      return isInsideBox(px, py, calibration.bodyBoxPx) ? "Body A" : "Head A";
    case "dZone": {
      // Between the head box and the body box (the neck/shoulders) doesn't score.
      const betweenHeadAndBody = py > calibration.headBoxPx.maxY && py < calibration.bodyBoxPx.minY;
      return betweenHeadAndBody ? "Neck (no-score)" : "D";
    }
    default:
      return "Unknown (line/text)";
  }
}
