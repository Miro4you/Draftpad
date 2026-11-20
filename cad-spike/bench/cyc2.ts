import opencascade from 'replicad-opencascadejs';
import { setOC } from 'replicad';
import { createRequire } from 'node:module';
import { cycloidProfile } from '../src/curves.ts';
import { buildSolid } from '../src/model.ts';
const require = createRequire(import.meta.url);
setOC(await (opencascade as any)({ locateFile: () => require.resolve('replicad-opencascadejs/wasm') }));
for (const [bore, r] of [[22, 0.8], [22, 0.5], [18, 0.8]] as const) {
  const res = buildSolid({ loops: cycloidProfile({ R: 30, Rr: 3, E: 1.5, N: 12, bore, holes: 6, holeD: 9, holeR: 17 }), height: 8, fillet: r });
  console.log(`Bohrung ${bore}, r ${r}:`, res.warning ?? 'ok', Math.round(res.times.verrunden), 'ms');
}
