// The only module that talks to js-ballistics. Imported as a version-pinned ESM CDN URL so the
// app needs no build step. js-ballistics is pre-1.0 (beta) with prior breaking changes between
// versions, so this pin is deliberate -- bump it only with a deliberate re-verification pass.
import {
  Calculator, Shot, Weapon, Ammo, DragModel, DragTables, Atmo, Wind, UNew, Unit,
} from "https://cdn.jsdelivr.net/npm/js-ballistics@3.0.0-beta.4/dist/index.js";

import { clamp } from "./utils.js";

export const DRAG_MODELS = ["G1", "G7"];

const TRAJECTORY_STEP_YD = 2;
const MIN_TRAJECTORY_MAX_RANGE_YD = 120;
const TRAJECTORY_MARGIN_YD = 20;

// Reused across calls; js-ballistics initializes its WASM module lazily on first use.
const calculator = new Calculator();

/**
 * Runs one full "expensive" ballistics solve: re-zeros the weapon for the given
 * configuration, then fires a trajectory sampled every TRAJECTORY_STEP_YD yards.
 * This is the only place in the app that awaits a WASM call -- callers should
 * cache the result and use interpolateTrajectory() for per-frame lookups.
 *
 * @param {{bc:number, dragModel:string, bulletWeightGr:number, mvFps:number, sightHeightIn:number, zeroDistanceYd:number}} zeroConfig
 * @param {{
 *   maxRangeYd?: number,
 *   advanced?: {
 *     windSpeedMph: number, windDirectionDeg: number,
 *     temperatureF: number, pressureInHg: number, humidityPct: number, altitudeFt: number,
 *     twistIn: number,
 *     lookAngleDeg: number, cantAngleDeg: number,
 *     coriolisLatitudeDeg: number, coriolisAzimuthDeg: number,
 *   } | null,
 * }} [options] - maxRangeYd extends the fired trajectory to cover a user-controlled range
 *   slider max; advanced carries the optional wind/atmosphere/twist/angle/Coriolis inputs
 *   (null/omitted means standard ICAO atmosphere, no wind, no spin drift, no cant/slant,
 *   no Coriolis -- the original flat-range behavior).
 * @returns {Promise<Array<{rangeYd:number, dropIn:number, windageIn:number}>>}
 */
export async function computeTrajectoryTable(zeroConfig, { maxRangeYd: maxRangeOverride, advanced = null } = {}) {
  const dragTable = DragTables[zeroConfig.dragModel];
  if (!dragTable) {
    throw new Error(`Unknown drag model "${zeroConfig.dragModel}"`);
  }

  const dm = new DragModel({
    bc: zeroConfig.bc,
    dragTable,
    weight: UNew.Grain(zeroConfig.bulletWeightGr),
  });
  const ammo = new Ammo({ dm, mv: UNew.FPS(zeroConfig.mvFps) });

  const weaponOptions = { sightHeight: UNew.Inch(zeroConfig.sightHeightIn) };
  if (advanced && advanced.twistIn > 0) {
    weaponOptions.twist = UNew.Inch(advanced.twistIn);
  }
  const weapon = new Weapon(weaponOptions);

  const shotOptions = { weapon, ammo };
  if (advanced) {
    shotOptions.atmo = new Atmo({
      temperature: UNew.Fahrenheit(advanced.temperatureF),
      pressure: UNew.InHg(advanced.pressureInHg),
      humidity: advanced.humidityPct / 100,
      altitude: UNew.Foot(advanced.altitudeFt),
    });
    if (advanced.windSpeedMph > 0) {
      shotOptions.winds = [
        new Wind({
          velocity: UNew.MPH(advanced.windSpeedMph),
          directionFrom: UNew.Degree(advanced.windDirectionDeg),
        }),
      ];
    }
    shotOptions.lookAngle = UNew.Degree(advanced.lookAngleDeg);
    shotOptions.cantAngle = UNew.Degree(advanced.cantAngleDeg);
    shotOptions.coriolis = {
      latitudeDeg: advanced.coriolisLatitudeDeg,
      azimuthDeg: advanced.coriolisAzimuthDeg,
    };
  }
  const shot = new Shot(shotOptions);

  await calculator.setWeaponZero(shot, UNew.Yard(zeroConfig.zeroDistanceYd));

  const maxRangeYd = Math.max(
    MIN_TRAJECTORY_MAX_RANGE_YD,
    zeroConfig.zeroDistanceYd + TRAJECTORY_MARGIN_YD,
    maxRangeOverride ?? 0
  );
  const hit = await calculator.fire({
    shot,
    trajectoryRange: UNew.Yard(maxRangeYd),
    trajectoryStep: UNew.Yard(TRAJECTORY_STEP_YD),
  });

  return hit.trajectory
    .map((pt) => ({
      rangeYd: pt.distance.In(Unit.Yard),
      dropIn: pt.height.In(Unit.Inch),
      windageIn: pt.windage.In(Unit.Inch),
    }))
    .sort((a, b) => a.rangeYd - b.rangeYd);
}

/**
 * Pure, synchronous linear interpolation over a cached trajectory table. This is the
 * "cheap path" hot function -- called on every aimpoint/range-slider redraw so those
 * interactions never touch WASM.
 */
export function interpolateTrajectory(table, rangeYd) {
  if (!table || table.length === 0) return { dropIn: 0, windageIn: 0 };

  const clamped = clamp(rangeYd, table[0].rangeYd, table[table.length - 1].rangeYd);

  let lo = 0;
  while (lo < table.length - 2 && table[lo + 1].rangeYd < clamped) lo++;
  const a = table[lo];
  const b = table[lo + 1] ?? a;

  const span = b.rangeYd - a.rangeYd;
  const t = span === 0 ? 0 : (clamped - a.rangeYd) / span;

  return {
    dropIn: a.dropIn + (b.dropIn - a.dropIn) * t,
    windageIn: a.windageIn + (b.windageIn - a.windageIn) * t,
  };
}
