// Canvas drawing. Mirrors the marker conventions from legacy-python-viz/map_hits.py:
// the red-dot reticle (MOA-scaled) is drawn wherever the shooter's optic actually is --
// the aim point in impact mode, or the calculated hold point in holdover mode -- a blue
// cross marks the other, purely conceptual point (impact mode's point of impact result,
// or holdover mode's desired target point), and an optional green circle shows expected
// group dispersion around the impact/hold point.

const AIM_CROSS_COLOR = "rgb(0, 100, 255)";
const POI_MARKER_COLOR = "rgb(0, 0, 0)";
const RETICLE_DOT_COLOR = "rgb(255, 0, 0)";
const GROUP_CIRCLE_COLOR = "rgb(0, 150, 0)";

// Sizes are ratios of canvas.width (the target image's native resolution), not fixed pixel
// counts, so they stay legible whether the browser displays the canvas large or small --
// CSS scales the whole canvas uniformly, so a size expressed as width/N always occupies the
// same fraction of the visible area.
function markerRadius(canvas) {
  return Math.max(10, canvas.width / 100);
}

function lineWidthFor(canvas) {
  return Math.max(4, canvas.width / 320);
}

function fontSizeFor(canvas) {
  return Math.max(28, canvas.width / 48);
}

function drawCross(ctx, x, y, size, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  ctx.moveTo(x - size, y);
  ctx.lineTo(x + size, y);
  ctx.moveTo(x, y - size);
  ctx.lineTo(x, y + size);
  ctx.stroke();
}

function drawDot(ctx, x, y, radius, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = "black";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawEllipse(ctx, x, y, rx, ry, { fill, stroke, lineWidth } = {}) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lineWidth ?? 2;
    ctx.stroke();
  }
}

function drawInfoBox(ctx, lines, x, y, fontSizePx) {
  ctx.font = `${fontSizePx}px sans-serif`;
  const padding = fontSizePx * 0.6;
  const lineHeight = fontSizePx * 1.25;
  const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + padding * 2;
  const height = lines.length * lineHeight + padding * 2;

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.strokeStyle = "rgb(60,60,60)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 8);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "black";
  lines.forEach((line, i) => {
    ctx.fillText(line, x + padding, y + padding + (i + 1) * lineHeight - lineHeight * 0.3);
  });
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {{
 *   image: CanvasImageSource,
 *   mode: 'impact'|'holdover',
 *   aimPointPx: {x:number,y:number},
 *   markerPx: {x:number,y:number},
 *   zoneLabel: string,
 *   rangeYd: number,
 *   dropIn: number,
 *   windageIn: number,
 *   status: string,
 *   dotMoa: number,
 *   dotRadiusPx: {rx:number, ry:number},
 *   groupMoa: number|null,
 *   groupRadiusPx: {rx:number, ry:number}|null,
 *   elevationOffsetIn: number,
 *   windageOffsetIn: number,
 *   zoom: number,
 *   zoomAnchorPx: {x:number,y:number}|null,
 * }} state
 */
export function drawFrame(ctx, state) {
  const canvas = ctx.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // "Scale target, not dot" mode: draw the target image itself smaller/larger instead of
  // growing the reticle -- like looking through a fixed-power scope, where the reticle stays
  // a constant apparent size and the target appears to shrink/grow with distance. The zoom is
  // always centered on the aimpoint (zoomAnchorPx), which maps to the canvas center -- so the
  // aimpoint's on-screen position stays put and the target pans/scales underneath it. zoom===1
  // with no anchor (the default) reproduces the original behavior exactly: full-size image,
  // no offset, and world coords equal screen coords.
  const zoom = state.zoom ?? 1;
  const anchorWorld = state.zoomAnchorPx ?? { x: canvas.width / 2, y: canvas.height / 2 };
  const anchorScreen = { x: canvas.width / 2, y: canvas.height / 2 };

  const toScreen = (pt) => ({
    x: anchorScreen.x + (pt.x - anchorWorld.x) * zoom,
    y: anchorScreen.y + (pt.y - anchorWorld.y) * zoom,
  });

  const imageTopLeft = toScreen({ x: 0, y: 0 });
  ctx.drawImage(state.image, imageTopLeft.x, imageTopLeft.y, canvas.width * zoom, canvas.height * zoom);

  const aimScreen = toScreen(state.aimPointPx);
  const markerScreen = toScreen(state.markerPx);

  const radius = markerRadius(canvas);
  const lineWidth = lineWidthFor(canvas);

  // The red-dot reticle (MOA-scaled) marks wherever the shooter's optic actually sits: the
  // aim point in impact mode, or the calculated hold point in holdover mode. The blue cross
  // marks the other, conceptual point (point of impact in impact mode; desired target in
  // holdover mode). Reticle/marker sizes are never multiplied by zoom -- their on-screen size
  // is already resolved upstream (constant in "scale target" mode, range-scaled otherwise).
  if (state.mode === "impact") {
    drawEllipse(ctx, aimScreen.x, aimScreen.y, state.dotRadiusPx.rx, state.dotRadiusPx.ry, {
      fill: RETICLE_DOT_COLOR,
    });
    drawDot(ctx, markerScreen.x, markerScreen.y, radius, POI_MARKER_COLOR);
  } else {
    drawCross(ctx, aimScreen.x, aimScreen.y, radius * 3, AIM_CROSS_COLOR, lineWidth);
    drawEllipse(ctx, markerScreen.x, markerScreen.y, state.dotRadiusPx.rx, state.dotRadiusPx.ry, {
      fill: RETICLE_DOT_COLOR,
    });
  }

  // Drawn last so the group circle's outline stays visible on top of the reticle/marker fill.
  if (state.groupRadiusPx) {
    drawEllipse(ctx, markerScreen.x, markerScreen.y, state.groupRadiusPx.rx, state.groupRadiusPx.ry, {
      stroke: GROUP_CIRCLE_COLOR,
      lineWidth,
    });
  }

  const modeLabel = state.mode === "impact" ? "Point of impact" : "Holdover";
  const lines = [
    `Mode: ${modeLabel}`,
    `Range: ${state.rangeYd.toFixed(1)} yd`,
    `Drop: ${state.dropIn.toFixed(2)} in`,
    `Windage: ${state.windageIn.toFixed(2)} in`,
    `Zone: ${state.zoneLabel}`,
    `Red dot: ${state.dotMoa.toFixed(1)} MOA`,
  ];
  if (state.elevationOffsetIn || state.windageOffsetIn) {
    lines.push(`Zero offset: ${state.elevationOffsetIn.toFixed(1)}"el / ${state.windageOffsetIn.toFixed(1)}"wind`);
  }
  if (state.groupRadiusPx) lines.push(`Group: ${state.groupMoa.toFixed(1)} MOA`);
  if (zoom !== 1) lines.push(`Target zoom: ${zoom.toFixed(2)}x`);
  if (state.status === "recomputing") lines.push("(recalculating…)");
  if (state.status === "error") lines.push("(calculation error)");

  drawInfoBox(ctx, lines, canvas.width * 0.01, canvas.width * 0.01, fontSizeFor(canvas));
}
