/**
 * Headless smoke test for the convective atmosphere core.
 *
 * Usage: npm test -- [cape] [N] [NZ] [hours] [--eff=.. --charge=..]
 *   cape   : target surface-based CAPE in J/kg          (default: 2200)
 *   N, NZ  : horizontal / vertical grid points          (default: 64 36)
 *   hours  : simulated hours to integrate               (default: 4)
 *   flags  : lake, land, spawn, freeze, evap, eff, charge, melt, precipT
 *
 * Runs the analytical thermo validation suite first, then integrates the
 * full 3D model and prints diagnostics every 30 simulated minutes, including
 * tornado, charge-separation and tripole diagnostics. Exits non-zero if a
 * validation check fails or the solution blows up (non-finite kinetic energy).
 */
import { Atmosphere } from '../src/sim/atmosphere';
import { runValidation, parcelAscent } from '../src/sim/thermo';
import { runRadiationValidation } from '../src/sim/radiation';
import { DEFAULT_PARAMS, SimParams, clampParams } from '../src/sim/params';
import { Terrain } from '../src/sim/terrain';

const args = process.argv.slice(2);
const flags = new Map<string, number>();
for (const a of args.filter((x) => x.startsWith('--'))) {
  const [k, v] = a.slice(2).split('=');
  flags.set(k, Number(v));
}
const pos = args.filter((x) => !x.startsWith('--'));
const cape = Number(pos[0] ?? 2200);
const N = Number(pos[1] ?? 64);
const NZ = Number(pos[2] ?? 36);
const hours = Number(pos[3] ?? 4);
const params: SimParams = clampParams({
  ...DEFAULT_PARAMS,
  cape,
  lakeEvap: flags.get('lake') ?? DEFAULT_PARAMS.lakeEvap,
  landEvap: flags.get('land') ?? DEFAULT_PARAMS.landEvap,
  dropletSpawn: flags.get('spawn') ?? DEFAULT_PARAMS.dropletSpawn,
  freezing: flags.get('freeze') ?? DEFAULT_PARAMS.freezing,
  evaporation: flags.get('evap') ?? DEFAULT_PARAMS.evaporation,
  precipEfficiency: flags.get('eff') ?? DEFAULT_PARAMS.precipEfficiency,
  chargeRate: flags.get('charge') ?? DEFAULT_PARAMS.chargeRate,
  melting: flags.get('melt') ?? DEFAULT_PARAMS.melting,
  precipTempC: flags.get('precipT') ?? DEFAULT_PARAMS.precipTempC,
});
if (!isFinite(cape)) {
  console.error('cape must be a number of J/kg, e.g. `npm test -- 2500 64 36 4`');
  process.exit(2);
}

const checks = runValidation();
for (const c of checks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.value, c.expect);
const radChecks = runRadiationValidation();
for (const c of radChecks) console.log(c.ok ? 'PASS' : 'FAIL', c.name, c.value, c.expect);
const allChecks = [...checks, ...radChecks];
const failed = allChecks.filter((c) => !c.ok).length;
console.log(`validation: ${allChecks.length - failed}/${allChecks.length} passed`);

const t0 = Date.now();
const terr = new Terrain(256);
console.log('terrain', Date.now() - t0, 'ms');

const a = new Atmosphere(N, NZ, params, terr);
console.log('environment SBCAPE', a.env.cape.toFixed(0), 'J/kg (target', params.cape + ')');

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
let cgNeg = 0;
let cgPos = 0;
let ic = 0;
let cc = 0;
let anvil = 0;
let groundFlashes = 0;
let peakQg = 0;
let peakEsf = 0;
let blowup = false;
let peakW = 0;
let peakRain = 0;
let tornadoSeen = false;
let peakTornado = 0;
let peakTripole = 0;

while (a.time < tEnd) {
  a.step();
  steps++;
  for (const e of a.flashEvents) {
    flashes++;
    if (e.fromGround) groundFlashes++;
    if (e.type === 'CG-') cgNeg++;
    else if (e.type === 'CG+') cgPos++;
    else if (e.type === 'CC') cc++;
    else if (e.type === 'ANVIL') anvil++;
    else ic++;
    if (flashes <= 40) {
      const strike = e.strike ? e.strike.map((v: number) => v.toFixed(0)).join(',') : '-';
      console.log(
        `  FLASH t=${(a.time / 3600).toFixed(3)}h ${e.type}${e.fromGround ? '(ground)' : ''} segs=${e.segs.length / 10} ` +
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
    tornadoSeen = tornadoSeen || s.tornadoActive > 0;
    peakTornado = Math.max(peakTornado, s.tornadoIntensity);
    peakTripole = Math.max(peakTripole, s.chargeTripole);
    peakQg = Math.max(peakQg, a.qgMax);
    peakEsf = Math.max(peakEsf, s.maxEz0 || 0);
    console.log(
      `t=${(a.time / 3600).toFixed(2)}h dt=${a.dt.toFixed(1)} step=${((Date.now() - tw) / steps).toFixed(0)}ms ` +
        `maxW=${s.maxW.toFixed(1)}/${s.minW.toFixed(1)} qc=${(s.maxQc * 1e3).toFixed(2)} qi=${(s.maxQi * 1e3).toFixed(2)} ` +
        `qr=${(s.maxQr * 1e3).toFixed(2)} qg=${(s.maxQg * 1e3).toFixed(2)} rain=${s.maxRain.toFixed(1)} cf=${s.cloudFrac.toFixed(2)} ` +
        `cp=${s.coldPool.toFixed(3)}/${s.coldPoolMin.toFixed(1)} Ts=${s.meanTs.toFixed(1)} div=${s.maxDiv.toExponential(1)} ` +
        `cfl=${s.cfl.toFixed(2)} wres=${s.waterRes.toExponential(1)} eres=${s.energyRes.toExponential(1)} ` +
        `E=${(s.maxE / 1e3).toFixed(0)}kV/m Ez0=${((s.maxEz0 || 0) / 1e3).toFixed(0)} r=${s.maxEratio.toFixed(2)} fl=${flashes} UH=${s.maxUH.toFixed(0)} ` +
        `KE=${s.KE.toExponential(1)} chMax=${a.chargeMax.toExponential(1)} Q+=${s.chargePos.toExponential(1)} Q-=${s.chargeNeg.toExponential(1)} ` +
        `TOR=${s.tornadoActive ? `EF${s.tornadoEF} ${s.maxTornadoWind.toFixed(0)}m/s ${s.tornadoPressure.toFixed(0)}hPa` : `pot=${s.tornadoPotential.toFixed(2)}`} ` +
        `CH=${(s.chargeSep / 1e3).toFixed(1)}kC/s tri=${s.chargeTripole.toFixed(2)}`,
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
    `flashes ${flashes} (CG- ${cgNeg}, CG+ ${cgPos}, IC ${ic}, CC ${cc}, ANVIL ${anvil}) [ground-initiated ${groundFlashes}], peak surface charge ${peakQg.toExponential(1)} C/m², peak surface field ${(peakEsf / 1e3).toFixed(0)} kV/m, peak w ${peakW.toFixed(1)} m/s, peak rain ${peakRain.toFixed(1)} mm/h, ` +
    `tornado ${tornadoSeen ? 'YES' : 'no'}, peak vortex ${peakTornado.toFixed(2)}, peak tripole ${peakTripole.toFixed(2)}` +
    `\nground-trigger: gate-calls ${a.gd.call}, candidate-cells ${a.gd.cand}, r>0.55 cells ${a.gd.pass}, spacing-blocked ${a.gd.blk}, selected ${a.gd.sel}, rolls ${a.gd.roll}, max r ${a.gd.maxR.toFixed(2)} (bar 0.55)`,
);
console.log(blowup ? 'RESULT: FAIL (blow-up)' : failed ? `RESULT: FAIL (${failed} validation checks)` : 'RESULT: PASS');
process.exit(blowup || failed ? 1 : 0);
