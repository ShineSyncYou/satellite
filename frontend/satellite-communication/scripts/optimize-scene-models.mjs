// Usage: node scripts/optimize-scene-models.mjs <tool-directory>
// Tool directory dependencies: @gltf-transform/{core,extensions,functions},
// draco3dgltf, meshoptimizer, gltf-validator. Original files remain untouched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const toolDirectory = path.resolve(process.argv[2] || project);
const requireTool = createRequire(path.join(toolDirectory, 'package.json'));
const { NodeIO } = requireTool('@gltf-transform/core');
const { ALL_EXTENSIONS } = requireTool('@gltf-transform/extensions');
const { dedup, prune, weld, simplify, draco } = requireTool('@gltf-transform/functions');
const draco3d = requireTool('draco3dgltf');
const { MeshoptSimplifier } = await import(pathToFileURL(requireTool.resolve('meshoptimizer')).href);
const validator = requireTool('gltf-validator');
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const jobs = [
  { name: 'aircraft-v1', ratio: 0.07, error: 0.001 },
  { name: 'radar' },
  { name: 'tdrs', ratio: 0.25, error: 0.001 },
  { name: 'ground-station' },
];

function geometry(document) {
  let triangles = 0, vertices = 0, primitives = 0;
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      vertices += primitive.getAttribute('POSITION')?.getCount() || 0;
      triangles += (primitive.getIndices()?.getCount() || primitive.getAttribute('POSITION')?.getCount() || 0) / 3;
      primitives++;
    }
  }
  return { triangles, vertices, primitives, nodes: document.getRoot().listNodes().length,
    materials: document.getRoot().listMaterials().length, textures: document.getRoot().listTextures().length };
}

const report = [];
for (const job of jobs) {
  const input = path.join(project, 'public/pictures', `${job.name}.glb`);
  const output = path.join(project, 'public/pictures', `${job.name}-optimized-v1.glb`);
  const document = await io.read(input);
  const before = { bytes: (await fs.stat(input)).size, ...geometry(document) };
  await document.transform(dedup(), weld());
  if (job.ratio) await document.transform(simplify({ simplifier: MeshoptSimplifier, ratio: job.ratio, error: job.error }));
  await document.transform(prune(), draco({ method: 'edgebreaker', encodeSpeed: 0, decodeSpeed: 5,
    quantizePosition: 16, quantizeNormal: 12, quantizeTexcoord: 14 }));
  await io.write(output, document);
  const decoded = await io.read(output);
  const after = { bytes: (await fs.stat(output)).size, ...geometry(decoded) };
  const validation = await validator.validateBytes(new Uint8Array(await fs.readFile(output)), { maxIssues: 100 });
  if (validation.issues.numErrors) throw new Error(`${job.name}: ${JSON.stringify(validation.issues)}`);
  // Validator 本身不解码 Draco；移除压缩扩展后再验证实际解码的几何数据。
  decoded.getRoot().listExtensionsUsed().find(extension => extension.extensionName === 'KHR_draco_mesh_compression')?.dispose();
  const decodedValidation = await validator.validateBytes(await io.writeBinary(decoded), { maxIssues: 100 });
  if (decodedValidation.issues.numErrors) throw new Error(`${job.name} decoded: ${JSON.stringify(decodedValidation.issues)}`);
  const row = { model: job.name, output: path.basename(output), settings: job, before, after,
    reductionPercent: Number(((1 - after.bytes / before.bytes) * 100).toFixed(1)),
    validation: validation.issues, decodedValidation: decodedValidation.issues };
  report.push(row);
  console.log(JSON.stringify({ model: row.model, before, after, reductionPercent: row.reductionPercent,
    errors: validation.issues.numErrors, decodedErrors: decodedValidation.issues.numErrors }));
}
const reportDir = path.join(project, 'docs/model-optimization');
await fs.mkdir(reportDir, { recursive: true });
await fs.writeFile(path.join(reportDir, 'report.json'), JSON.stringify(report, null, 2));
