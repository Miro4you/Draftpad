// Geometriekern im Hintergrund: hält das Zeichnen flüssig, während OpenCASCADE rechnet.
import opencascade from 'replicad-opencascadejs';
import wasmUrl from 'replicad-opencascadejs/wasm?url';
import { setOC, type Shape3D } from 'replicad';
import { buildSolid, type BuildParams } from './model';
import { makeThreeMF } from './threemf';

let shape: Shape3D | null = null;
const ready = (async () => {
  const t = performance.now();
  const oc = await (opencascade as unknown as (o: object) => Promise<unknown>)({ locateFile: () => wasmUrl });
  setOC(oc as never);
  postMessage({ type: 'ready', ms: performance.now() - t });
})();

function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Der Geometriekern konnte das Profil nicht bauen – schneidet es sich selbst, oder überlappen sich Profile teilweise?';
}

self.onmessage = async (ev: MessageEvent) => {
  await ready;
  const msg = ev.data;
  try {
    if (msg.type === 'build') {
      const p = msg.params as BuildParams;
      const t0 = performance.now();
      const r = buildSolid(p);
      shape = r.shape;
      const t1 = performance.now();
      const m = r.shape.mesh({ tolerance: 0.02, angularTolerance: 0.2 });
      const e = r.shape.meshEdges({ tolerance: 0.02, angularTolerance: 0.2 });
      const t2 = performance.now();
      const vertices = new Float32Array(m.vertices);
      const normals = new Float32Array(m.normals);
      const triangles = new Uint32Array(m.triangles);
      const lines = new Float32Array(e.lines);
      postMessage(
        {
          type: 'result',
          id: msg.id,
          vertices,
          normals,
          triangles,
          lines,
          volume: r.volume,
          faces: r.faces,
          warning: r.warning,
          times: { ...r.times, koerper_gesamt: t1 - t0, vernetzen: t2 - t1 },
        },
        { transfer: [vertices.buffer, normals.buffer, triangles.buffer, lines.buffer] },
      );
    } else if (msg.type === 'export') {
      if (!shape) throw new Error('Noch kein Körper');
      const t = performance.now();
      let blob: Blob;
      if (msg.format === 'step') blob = shape.blobSTEP();
      else if (msg.format === 'stl') blob = shape.blobSTL({ binary: true, tolerance: 0.01, angularTolerance: 0.1 });
      else {
        const m = shape.mesh({ tolerance: 0.01, angularTolerance: 0.1 });
        blob = makeThreeMF(m.vertices, m.triangles, msg.name ?? 'Teil');
      }
      postMessage({ type: 'exported', id: msg.id, format: msg.format, blob, ms: performance.now() - t });
    }
  } catch (e) {
    postMessage({ type: 'error', id: msg.id, message: errText(e) });
  }
};
