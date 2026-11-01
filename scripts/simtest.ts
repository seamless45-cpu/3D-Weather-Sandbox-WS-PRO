/**
 * Headless smoke test for the convective atmosphere core.
 *
 * Usage: npm test -- [preset] [N] [NZ] [hours]
 *   preset : capped | fairwx | pulse | squall | super   (default: pulse)
 *   N, NZ  : horizontal / vertical grid points          (default: 64 36)
 *   hours  : simulated hours to integrate               (default: 4)
 *
 * Runs the analytical thermo validation suite first, then integrates the
 * full 3D model and prints diagnostics every 30 simulated minutes. Exits
 * non-zero if a validation check fails, the preset is unknown, or the
 * solution blows up (non-finite kinetic energy).
 */
import { Atmosphere } from '../src/sim/atmosphere';
import { PRESETS, runValidation, parcelAscent } from '../src/sim/thermo';
import { Terrain } from '../src/sim/terrain';

const [pid = 'pulse', nArg, nzArg, hoursArg] = process.argv.slice(2);
const N = Number(nArg || 64);
const NZ = Number(nzArg || 36);
const hours = Number(hoursArg || 4);

const preset = PRESETS.find((p) => p.id === pid);
if (!preset) {
  console.error(`unknown preset "${pid}" — choose from: ${PRESETS.map((p) => p.id).join(', ')}`);
  process.exit(2);
}

const checks = runValidation();
for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.value, c.expect);
const failed = checks.filter((c) => !c.ok).length;
console.log(`validation: ${checks.length - failed}/${checks.length} passed`);

const t0 = Date.now();
const terr = new Terrain(256);
console.log('terrain', Date.now() - t0, 'ms');

const a = new Atmosphere(N, NZ, preset, terr);

// Diagnostic sounding of the initial column.
const T = new Float64Array(NZ);
for (let k = 0; k < NZ; k++) T[k] = a.th[k * N * N] * a.prof.pi[k];
const qv = Array.from({ length: NZ }, (_, k) => a.qv[k * N * N]);
console.log('init column SB', parcelAscent(a.prof.z, a.prof.p, T, qv, 'SB'));

let tw = Date.now();
let steps = 0;
let nextPrint = 0;
const tEnd = a.time + hours * 3600;
let flashes = 0;
let blowup = false;
let peakW = 0;
let peakRain = 0;

while (a.time < tEnd) {
  a.step();
  steps++;
  for (const e of a.flashEvents) {
    flashes++;
    if (flashes <= 40) {
      const strike = e.strike ? e.strike.map((v: number) => v.toFixed(0)).join(',') : '-';
      console.log(
        `  FLASH t=${(a.time / 3600).toFixed(3)}h ${e.type} segs=${e.segs.length / 10} ` +
          `Q=${e.chargeC.toFixed(1)}C ratio=${e.ratio.toFixed(2)} init z=${e.init[1].toFixed(0)} ` +
          `strokes=${e.strokes.length} strike=${strike}`,
      );
    }
  }
  a.flashEvents.length = 0;
  if (a.time >= nextPrint) {
    nextPrint = a.time + 1800;
    const s = a.stats;
    peakW = Math.max(peakW, s.maxW);
    peakRain = Math.max(peakRain, s.maxRain);
    console.log(
      `t=${(a.time / 3600).toFixed(2)}h dt=${a.dt.toFixed(1)} step=${((Date.now() - tw) / steps).toFixed(0)}ms ` +
        `maxW=${s.maxW.toFixed(1)}/${s.minW.toFixed(1)} qc=${(s.maxQc * 1e3).toFixed(2)} qi=${(s.maxQi * 1e3).toFixed(2)} ` +
        `qr=${(s.maxQr * 1e3).toFixed(2)} qg=${(s.maxQg * 1e3).toFixed(2)} rain=${s.maxRain.toFixed(1)} cf=${s.cloudFrac.toFixed(2)} ` +
        `cp=${s.coldPool.toFixed(3)}/${s.coldPoolMin.toFixed(1)} Ts=${s.meanTs.toFixed(1)} div=${s.maxDiv.toExponential(1)} ` +
        `cfl=${s.cfl.toFixed(2)} wres=${s.waterRes.toExponential(1)} eres=${s.energyRes.toExponential(1)} ` +
        `E=${(s.maxE / 1e3).toFixed(0)}kV/m r=${s.maxEratio.toFixed(2)} fl=${flashes} UH=${s.maxUH.toFixed(0)} ` +
        `KE=${s.KE.toExponential(1)} chMax=${a.chargeMax.toExponential(1)} Q+=${s.chargePos.toExponential(1)} Q-=${s.chargeNeg.toExponential(1)}`,
    );
    if (!isFinite(s.KE)) {
      console.log('BLOWUP');
      blowup = true;
      break;
    }
  }
}

console.log(
  `total ${Date.now() - tw} ms, steps ${steps}, sim ${(hours).toFixed(2)} h, ` +
    `flashes ${flashes}, peak w ${peakW.toFixed(1)} m/s, peak rain ${peakRain.toFixed(1)} mm/h`,
);
console.log(blowup ? 'RESULT: FAIL (blow-up)' : failed ? `RESULT: FAIL (${failed} validation checks)` : 'RESULT: PASS');
process.exit(blowup || failed ? 1 : 0);
