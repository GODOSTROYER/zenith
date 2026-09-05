/** Validate the delivered, compressed binary assets rather than source geometry. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';

await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
const manifest = JSON.parse(await fs.readFile('public/gimbal/manifest.json', 'utf8'));
const signature = Buffer.from([171, 75, 84, 88, 32, 50, 48, 187, 13, 10, 26, 10]);
let referenceAtlas;
for (const lod of manifest.lods) {
  const file = `public${lod.file}`;
  const binary = await fs.readFile(file);
  const json = JSON.parse(binary.subarray(20, 20 + binary.readUInt32LE(12)).toString());
  assert(json.extensionsRequired.includes('EXT_meshopt_compression'));
  assert(json.extensionsRequired.includes('KHR_texture_basisu'));
  const doc = await io.read(file), root = doc.getRoot();
  assert.equal(root.listMaterials().length, 4);
  assert.equal(root.listSkins().length, 1);
  assert(root.listSkins()[0].listJoints().length <= 24);
  for (const eye of ['LeftEye', 'RightEye']) {
    assert(root.listSkins()[0].listJoints().some((joint) => joint.getName() === eye), `${eye} wink joint is missing.`);
  }
  const primitives = root.listMeshes().flatMap((mesh) => mesh.listPrimitives());
  assert.equal(primitives.length, 4);
  const triangles = primitives.reduce((sum, primitive) => sum + primitive.getIndices().getCount() / 3, 0);
  assert.equal(triangles, lod.triangles);
  assert(triangles <= (lod.lod === 0 ? 18000 : 8000));
  for (const primitive of primitives) {
    const positions = primitive.getAttribute('POSITION');
    assert(primitive.getIndices().getArray().every((index) => index < positions.getCount()));
    assert(positions.getArray().every(Number.isFinite));
    assert(primitive.getAttribute('WEIGHTS_0').getCount() === positions.getCount());
    assert(primitive.getAttribute('COLOR_0'), 'Baked contact occlusion must be present.');
  }
  assert.equal(root.listTextures().length, 1);
  const atlas = Buffer.from(root.listTextures()[0].getImage());
  assert(atlas.subarray(0, 12).equals(signature));
  assert.equal(atlas.readUInt32LE(20), 1024);
  assert.equal(atlas.readUInt32LE(24), 1024);
  if (referenceAtlas) assert(atlas.equals(referenceAtlas), 'Both LODs must share the same atlas.');
  referenceAtlas = atlas;
  const animations = new Map(root.listAnimations().map((clip) => [clip.getName(), clip]));
  const duration = (name) => Math.max(...animations.get(name).listSamplers().map((sampler) => Math.max(...sampler.getInput().getArray())));
  for (const [state, config] of Object.entries(manifest.states)) {
    assert(animations.has(state), `${state} clip is missing.`);
    assert(animations.has(config.reducedMotionClip));
    assert(Math.abs(duration(state) - config.duration) < 0.0001);
    for (const sampler of animations.get(config.reducedMotionClip).listSamplers()) {
      const values = sampler.getOutput().getArray(), stride = sampler.getOutput().getElementSize();
      for (let i = stride; i < values.length; i++) assert.equal(values[i], values[i % stride], `${state} reduced-motion pose must be static.`);
    }
  }
  for (const transition of manifest.transitions) {
    assert(animations.has(transition.clip));
    assert(Math.abs(duration(transition.clip) - 0.2) < 0.0001);
  }
  assert.equal(animations.size, 30);
  console.log(`${file}: ${triangles} triangles; ${root.listSkins()[0].listJoints().length} bones; 4 draw calls; 30 clips; one 1024² Basis atlas; Meshopt decode passed.`);
}
for (const name of ['model-views.png', 'state-poses.png', 'production-sheet.png', 'basis/basis_transcoder.js', 'basis/basis_transcoder.wasm', 'basis/LICENSE', 'basis/NOTICE', 'basis/README.md', ...Object.keys(manifest.states).map((state) => `poses/${state}.png`)]) {
  assert((await fs.stat(`public/gimbal/${name}`)).size > 0, `${name} is missing.`);
}
console.log('All production asset checks passed.');
