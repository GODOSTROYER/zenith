/**
 * Original procedural Gimbal production asset. No third-party character assets.
 * Run: node scripts/gimbal-build.mjs
 * Four rigidly weighted skinned primitives, one atlas, deterministic animation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, meshopt, resample } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import sharp from 'sharp';
import { withGimbalProvenance } from './gimbal-png.mjs';

const OUTPUT = path.resolve('public/gimbal');
const STATES = ['planning', 'awaiting_approval', 'applying', 'verified', 'blocked'];
const COLORS = { planning: '#a78bfa', awaiting_approval: '#f4be62', applying: '#60a5fa', verified: '#6ed6a5', blocked: '#f17f82' };
const LABELS = { planning: 'Planning', awaiting_approval: 'Awaiting approval', applying: 'Applying', verified: 'Verified', blocked: 'Blocked' };
const DURATION = { planning: 2, awaiting_approval: 1 / 30, applying: 1.2, verified: 0.7, blocked: 0.25 };
const MATERIAL_NAMES = ['Gimbal_Ceramic', 'Gimbal_Metal', 'Gimbal_Face', 'Gimbal_Accent'];
const MATERIAL_COLORS = ['#48535f', '#a5b1ba', '#101b24', '#a78bfa'];
const RIG = [
  ['Root', null, [0, 0, 0]],
  ['Torso', 'Root', [0, -0.28, 0]],
  ['Head', 'Torso', [0, 1.06, 0.025]],
  ['LeftEye', 'Head', [-0.26, 0.015, 0.648]],
  ['RightEye', 'Head', [0.26, 0.015, 0.648]],
  ['LeftShoulder', 'Torso', [-0.58, 0.28, 0]],
  ['LeftElbow', 'LeftShoulder', [-0.22, -0.36, 0.015]],
  ['LeftHand', 'LeftElbow', [-0.10, -0.29, 0.06]],
  ['RightShoulder', 'Torso', [0.58, 0.28, 0]],
  ['RightElbow', 'RightShoulder', [0.22, -0.36, 0.015]],
  ['RightHand', 'RightElbow', [0.10, -0.29, 0.06]],
  ['LeftFoot', 'Root', [-0.32, -1.05, 0.06]],
  ['RightFoot', 'Root', [0.32, -1.05, 0.06]],
  ['RingInner', 'Root', [0, 0.08, -0.39]],
  ['RingMiddle', 'Root', [0, 0.08, -0.39]],
  ['RingOuter', 'Root', [0, 0.08, -0.39]],
  ['ProgressMarker', 'RingOuter', [0, 0, 0]],
];
const bind = new Map();
for (const [name, parent, position] of RIG) {
  const matrix = new THREE.Matrix4().makeTranslation(...position);
  if (parent) matrix.premultiply(bind.get(parent));
  bind.set(name, matrix);
}

function rotation(x = 0, y = 0, z = 0) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z)).toArray();
}

/** Exactly one input state; presentation never parses language-model output. */
function pose(state) {
  const p = Object.fromEntries(RIG.map(([name]) => [name, [0, 0, 0]]));
  if (state === 'planning') {
    Object.assign(p, { Torso: [0.08, -0.08, -0.035], Head: [0.08, 0.14, -0.12], LeftShoulder: [-0.2, 0.12, -1.24], LeftElbow: [0, 0, -0.44], LeftHand: [-0.42, 0.1, 0.2], RightShoulder: [-0.15, 0, 0.2], RingInner: [0.48, -0.56, 0.1], RingMiddle: [-0.45, 0.28, -0.14], RingOuter: [0.1, -0.17, 0.15] });
  } else if (state === 'awaiting_approval') {
    Object.assign(p, { LeftShoulder: [-0.2, 0, -0.85], LeftElbow: [-0.2, 0, -0.45], LeftHand: [-0.95, 0, -0.1], RightShoulder: [-0.2, 0, 0.85], RightElbow: [-0.2, 0, 0.45], RightHand: [-0.95, 0, 0.1], RingInner: [0.035, 0, 0], RingMiddle: [-0.035, 0, 0], RingOuter: [0, 0, 0.12] });
  } else if (state === 'applying') {
    Object.assign(p, { Torso: [0.14, 0, 0], Head: [-0.07, 0, 0], LeftShoulder: [-0.56, 0, -0.25], LeftElbow: [-0.25, 0, -0.18], RightShoulder: [-0.56, 0, 0.25], RightElbow: [-0.25, 0, 0.18], LeftFoot: [0, 0.13, 0], RightFoot: [0, -0.13, 0], RingInner: [0.15, -0.25, 0], RingMiddle: [-0.24, 0.3, 0], RingOuter: [0.10, -0.14, 0.12] });
  } else if (state === 'verified') {
    Object.assign(p, { Head: [-0.03, 0, 0], LeftShoulder: [0, 0, -0.18], RightShoulder: [0, 0, 0.18], RingOuter: [0, 0, 0.12] });
  } else if (state === 'blocked') {
    Object.assign(p, { Torso: [0, -0.08, 0], Head: [0, 0.12, -0.035], LeftShoulder: [-0.3, -0.1, -1.68], LeftElbow: [0, 0, -0.6], LeftHand: [0, -0.1, 0.85], RightShoulder: [0, 0, 0.12], LeftFoot: [0, 0.12, 0], RightFoot: [0, -0.12, 0], RingInner: [0, 0.05, 0], RingMiddle: [0.04, 0, 0], RingOuter: [0.6, 0.64, -0.28] });
  }
  return p;
}

function buildGeometry(lod) {
  const components = [];
  const quality = lod === 0 ? 1 : 0.58;
  const sphere = () => new THREE.SphereGeometry(1, Math.round(20 * quality), Math.round(11 * quality));
  const box = () => new RoundedBoxGeometry(1, 1, 1, 1, 0.13);
  function add(name, material, bone, geometry, position, scale, angles = [0, 0, 0]) {
    const transform = new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion().fromArray(rotation(...angles)), new THREE.Vector3(...scale));
    geometry.applyMatrix4(transform);
    components.push({ name, material, bone, geometry });
  }
  function ellipsoid(name, material, bone, position, scale, angles) {
    add(name, material, bone, sphere(), position, scale, angles);
  }
  function rounded(name, material, bone, position, scale, angles) {
    add(name, material, bone, box(), position, scale, angles);
  }
  // Compact ceramic body, inlaid breastplate, and restrained brushed seams.
  ellipsoid('Torso cradle', 0, 'Torso', [0, 0, 0], [0.54, 0.49, 0.37]);
  rounded('Chest plate', 0, 'Torso', [0, 0.02, 0.29], [0.76, 0.52, 0.16]);
  rounded('Chest inset', 2, 'Torso', [0, 0.05, 0.381], [0.47, 0.28, 0.028]);
  rounded('Navigational datum', 1, 'Torso', [0, 0.055, 0.402], [0.25, 0.027, 0.018]);
  rounded('Chest tally left', 1, 'Torso', [-0.10, -0.035, 0.402], [0.027, 0.055, 0.018]);
  rounded('Chest tally right', 1, 'Torso', [0.10, -0.035, 0.402], [0.027, 0.055, 0.018]);
  ellipsoid('Waist collar', 1, 'Torso', [0, -0.39, -0.02], [0.36, 0.11, 0.29]);
  ellipsoid('Neck pivot', 1, 'Torso', [0, 0.49, 0], [0.23, 0.17, 0.22]);
  rounded('Rear spine', 1, 'Torso', [0, 0.05, -0.36], [0.16, 0.56, 0.13]);
  // Armored luminous head: the face is a recessed visor, not a floating orb.
  ellipsoid('Head ceramic shell', 0, 'Head', [0, 0, 0], [0.80, 0.62, 0.55]);
  ellipsoid('Visor rim', 1, 'Head', [0, -0.015, 0.40], [0.683, 0.428, 0.255]);
  ellipsoid('Dark visor', 2, 'Head', [0, -0.015, 0.443], [0.653, 0.392, 0.233]);
  rounded('Left eye aperture', 3, 'LeftEye', [0, 0, 0], [0.18, 0.215, 0.052], [0, -0.18, -0.05]);
  rounded('Right eye aperture', 3, 'RightEye', [0, 0, 0], [0.18, 0.215, 0.052], [0, 0.18, 0.05]);
  rounded('Left brow shutter', 0, 'Head', [-0.26, 0.18, 0.625], [0.27, 0.052, 0.06], [0, -0.16, 0.08]);
  rounded('Right brow shutter', 0, 'Head', [0.26, 0.18, 0.625], [0.27, 0.052, 0.06], [0, 0.16, -0.08]);
  for (const side of [-1, 1]) {
    ellipsoid(`Head side bearing ${side}`, 1, 'Head', [side * 0.765, -0.02, 0], [0.09, 0.23, 0.23]);
    ellipsoid(`Head side ceramic ${side}`, 0, 'Head', [side * 0.817, -0.02, 0], [0.046, 0.16, 0.16]);
    rounded(`Head seam ${side}`, 1, 'Head', [side * 0.48, 0.435, 0.19], [0.039, 0.15, 0.035], [0.28, 0, side * 0.65]);
    const prefix = side < 0 ? 'Left' : 'Right';
    ellipsoid(`${prefix} shoulder`, 1, `${prefix}Shoulder`, [0, 0, 0], [0.17, 0.17, 0.17]);
    ellipsoid(`${prefix} upper arm`, 0, `${prefix}Shoulder`, [side * 0.105, -0.18, 0], [0.13, 0.27, 0.13], [0, 0, side * 0.43]);
    ellipsoid(`${prefix} elbow`, 1, `${prefix}Elbow`, [0, 0, 0], [0.12, 0.12, 0.13]);
    ellipsoid(`${prefix} forearm`, 0, `${prefix}Elbow`, [side * 0.05, -0.14, 0.03], [0.13, 0.22, 0.15], [0, 0, side * 0.30]);
    rounded(`${prefix} wrist cuff`, 1, `${prefix}Hand`, [0, 0.06, 0], [0.23, 0.13, 0.22], [0, 0, side * 0.25]);
    rounded(`${prefix} mitten palm`, 0, `${prefix}Hand`, [side * 0.015, -0.10, 0.012], [0.29, 0.31, 0.18], [0, 0, side * 0.1]);
    ellipsoid(`${prefix} thumb`, 0, `${prefix}Hand`, [-side * 0.15, -0.055, 0.07], [0.09, 0.125, 0.085], [0, 0, -side * 0.35]);
    rounded(`${prefix} palm inset`, 2, `${prefix}Hand`, [side * 0.008, -0.105, 0.107], [0.17, 0.16, 0.016]);
    ellipsoid(`${prefix} ankle`, 1, `${prefix}Foot`, [0, 0.18, -0.025], [0.13, 0.23, 0.14]);
    rounded(`${prefix} magnetic foot`, 0, `${prefix}Foot`, [0, -0.075, 0.07], [0.43, 0.25, 0.62]);
    rounded(`${prefix} sole`, 2, `${prefix}Foot`, [0, -0.192, 0.065], [0.44, 0.075, 0.62]);
    rounded(`${prefix} toe`, 1, `${prefix}Foot`, [0, -0.07, 0.367], [0.29, 0.09, 0.035]);
  }
  // Three differently sized gyroscopic rails, with a deliberate outer opening.
  const rings = [['RingInner', 1.24, 0.033, Math.PI * 2, 0], ['RingMiddle', 1.48, 0.042, Math.PI * 2, 0], ['RingOuter', 1.73, 0.055, Math.PI * 1.76, Math.PI * 0.40]];
  for (const [bone, radius, tube, arc, start] of rings) {
    const segments = Math.round((lod === 0 ? 88 : 44) * arc / (Math.PI * 2));
    const torus = new THREE.TorusGeometry(radius, tube, lod === 0 ? 7 : 5, segments, arc);
    add(`${bone} rail`, 1, bone, torus, [0, 0, 0], [1, 1, 1], [0, 0, start]);
    if (bone === 'RingOuter') {
      add('Outer illuminated edge', 3, bone, new THREE.TorusGeometry(radius + 0.005, 0.013, 4, segments, arc), [0, 0, 0.047], [1, 1, 1], [0, 0, start]);
      for (const angle of [start, start + arc]) {
        ellipsoid(`Outer notch end ${angle}`, 0, bone, [Math.cos(angle) * radius, Math.sin(angle) * radius, 0], [0.092, 0.092, 0.092]);
      }
      for (let index = 0; index < 7; index++) {
        const angle = start + arc * (index + 1) / 8;
        rounded(`Outer reference tick ${index}`, 0, bone, [Math.cos(angle) * radius, Math.sin(angle) * radius, 0.055], [0.025, 0.092, 0.025], [0, 0, angle - Math.PI / 2]);
      }
    }
  }
  ellipsoid('Single clockwise progress marker', 3, 'ProgressMarker', [1.73, 0, 0.09], [0.09, 0.09, 0.055]);
  return components;
}

function bakeOcclusion(position, normal, material) {
  if (material === 3) return 1;
  // Baked contact shading in the face recess, below the core, and underneath armor.
  const underside = Math.max(0, -normal.y) * 0.13;
  const neckContact = Math.exp(-((position.y - 0.20) ** 2 / 0.025 + position.x ** 2 / 0.18 + position.z ** 2 / 0.3)) * 0.18;
  const torsoContact = position.y < -0.2 && Math.abs(position.x) > 0.52 && Math.abs(position.x) < 0.9 ? Math.max(0, -normal.x * Math.sign(position.x)) * 0.12 : 0;
  return Math.max(0.60, 1 - underside - neckContact - torsoContact);
}

async function createAtlas() {
  const data = Buffer.alloc(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++) {
    for (let x = 0; x < 1024; x++) {
      const u = (x % 512) / 511, v = (y % 512) / 511;
      const edge = Math.min(u, v, 1 - u, 1 - v);
      const value = Math.round(238 + 13 * Math.min(1, edge * 16) + 3 * Math.sin(v * Math.PI));
      const offset = (y * 1024 + x) * 4;
      data[offset] = value; data[offset + 1] = value; data[offset + 2] = value; data[offset + 3] = 255;
    }
  }
  return withGimbalProvenance(await sharp(data, { raw: { width: 1024, height: 1024, channels: 4 } }).png().toBuffer());
}

async function writePng(pipeline, destination) {
  await fs.writeFile(destination, withGimbalProvenance(await pipeline.png().toBuffer()));
}

function createDocument(components, atlas) {
  const doc = new Document();
  const buffer = doc.createBuffer('Gimbal');
  const scene = doc.createScene('Gimbal');
  const texture = doc.createTexture('Gimbal shared 1024 atlas').setImage(atlas).setMimeType('image/png').setURI('atlas.png');
  const materials = MATERIAL_NAMES.map((name, index) => {
    const c = new THREE.Color(MATERIAL_COLORS[index]);
    const mat = doc.createMaterial(name).setBaseColorFactor([c.r, c.g, c.b, 1]).setBaseColorTexture(texture).setRoughnessFactor([0.79, 0.56, 0.73, 0.58][index]).setMetallicFactor([0.14, 0.58, 0.12, 0.06][index]);
    if (index === 3) mat.setEmissiveFactor([c.r * 0.65, c.g * 0.65, c.b * 0.65]);
    return mat;
  });
  const nodes = Object.fromEntries(RIG.map(([name, , translation]) => [name, doc.createNode(name).setTranslation(translation)]));
  for (const [name, parent] of RIG) { if (parent) nodes[parent].addChild(nodes[name]); }
  scene.addChild(nodes.Root);
  const matrices = new Float32Array(RIG.length * 16);
  RIG.forEach(([name], i) => new THREE.Matrix4().copy(bind.get(name)).invert().toArray(matrices, i * 16));
  const accessor = (name, array, type) => doc.createAccessor(name).setType(type).setArray(array).setBuffer(buffer);
  const skin = doc.createSkin(`Gimbal ${RIG.length} bone rig`).setSkeleton(nodes.Root).setInverseBindMatrices(accessor('Inverse binds', matrices, 'MAT4'));
  for (const [name] of RIG) skin.addJoint(nodes[name]);
  const mesh = doc.createMesh('Gimbal four draw calls');
  const counts = [];
  for (let material = 0; material < materials.length; material++) {
    const positions = [], normals = [], uvs = [], colors = [], joints = [], weights = [], indices = [];
    for (const component of components.filter((item) => item.material === material)) {
      const geometry = component.geometry;
      const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal'), uv = geometry.getAttribute('uv');
      const boneIndex = RIG.findIndex(([name]) => name === component.bone);
      const world = bind.get(component.bone), normalMatrix = new THREE.Matrix3().getNormalMatrix(world);
      const offset = positions.length / 3;
      for (let vertex = 0; vertex < p.count; vertex++) {
        const position = new THREE.Vector3().fromBufferAttribute(p, vertex).applyMatrix4(world);
        const normal = new THREE.Vector3().fromBufferAttribute(n, vertex).applyNormalMatrix(normalMatrix);
        positions.push(...position.toArray()); normals.push(...normal.toArray());
        const ao = bakeOcclusion(position, normal, material);
        colors.push(ao, ao, ao);
        uvs.push((material % 2) * 0.5 + 0.02 + (uv ? uv.getX(vertex) : 0.5) * 0.46, Math.floor(material / 2) * 0.5 + 0.02 + (uv ? uv.getY(vertex) : 0.5) * 0.46);
        joints.push(boneIndex, 0, 0, 0); weights.push(1, 0, 0, 0);
      }
      if (geometry.index) { for (const index of geometry.index.array) indices.push(offset + index); }
      else { for (let index = 0; index < p.count; index++) indices.push(offset + index); }
    }
    const primitive = doc.createPrimitive().setMaterial(materials[material])
      .setAttribute('POSITION', accessor('Position', new Float32Array(positions), 'VEC3'))
      .setAttribute('NORMAL', accessor('Normal', new Float32Array(normals), 'VEC3'))
      .setAttribute('TEXCOORD_0', accessor('Atlas UV', new Float32Array(uvs), 'VEC2'))
      .setAttribute('COLOR_0', accessor('Baked ambient contact', new Float32Array(colors), 'VEC3'))
      .setAttribute('JOINTS_0', accessor('Rigid bone indices', new Uint16Array(joints), 'VEC4'))
      .setAttribute('WEIGHTS_0', accessor('Rigid bone weights', new Float32Array(weights), 'VEC4'))
      .setIndices(accessor('Triangles', new Uint16Array(indices), 'SCALAR'));
    mesh.addPrimitive(primitive);
    counts.push(indices.length / 3);
  }
  scene.addChild(doc.createNode('GimbalMesh').setMesh(mesh).setSkin(skin));

  function addClip(name, frames, interpolation = 'LINEAR') {
    const animation = doc.createAnimation(name);
    const times = accessor(`${name} times`, new Float32Array(frames.map((frame) => frame.t)), 'SCALAR');
    for (const [bone] of RIG) {
      const values = new Float32Array(frames.flatMap((frame) => rotation(...frame.pose[bone])));
      const sampler = doc.createAnimationSampler().setInput(times).setOutput(accessor(`${name} ${bone}`, values, 'VEC4')).setInterpolation(interpolation);
      animation.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes[bone]).setTargetPath('rotation').setSampler(sampler));
      if (bone.startsWith('Ring')) {
        const scales = new Float32Array(frames.flatMap((frame) => {
          const pulse = name === 'verified' ? 1 + 0.035 * Math.sin(Math.PI * Math.min(1, frame.t / 0.48)) : 1;
          return [pulse, pulse, pulse];
        }));
        const scaleSampler = doc.createAnimationSampler().setInput(times).setOutput(accessor(`${name} ${bone} scale`, scales, 'VEC3')).setInterpolation('LINEAR');
        animation.addSampler(scaleSampler).addChannel(doc.createAnimationChannel().setTargetNode(nodes[bone]).setTargetPath('scale').setSampler(scaleSampler));
      }
    }
  }
  for (const state of STATES) {
    addClip(`pose_${state}`, [{ t: 0, pose: pose(state) }, { t: 1 / 30, pose: pose(state) }]);
    if (state === 'planning') {
      const steps = [0, 0.32, 0.39, 0.76, 0.83, 1.21, 1.28, 1.66, 1.74, 2];
      const phases = [0, 0, 1, 1, 2, 2, 1, 1, 0, 0];
      addClip(state, steps.map((t, index) => {
        const p = pose(state), phase = phases[index];
        p.RingInner[1] += [0, 0.32, -0.18][phase]; p.RingMiddle[0] += [0, 0.20, -0.22][phase]; p.RingOuter[2] += [0, -0.12, 0.16][phase];
        p.Head[1] += [0, -0.1, 0.11][phase]; p.LeftHand[2] += [0, -0.12, 0.08][phase];
        return { t, pose: p };
      }));
    } else if (state === 'applying') {
      addClip(state, Array.from({ length: 37 }, (_, index) => {
        const p = pose(state), t = index / 30;
        p.RingOuter[2] -= t / 1.2 * Math.PI * 2;
        return { t, pose: p };
      }));
    } else if (state === 'verified') {
      addClip(state, [0, 0.12, 0.28, 0.48, 0.7].map((t, index) => {
        const p = pose(state); p.Head[0] += [0, 0.03, 0.19, 0, 0][index];
        p.RingInner[1] = [0.14, 0, 0, 0, 0][index]; p.RingMiddle[0] = [-0.14, 0, 0, 0, 0][index];
        return { t, pose: p };
      }));
    } else if (state === 'blocked') {
      addClip(state, [0, 0.12, 0.25].map((t, index) => {
        const p = pose(state); p.RingOuter[0] += [-0.05, 0.012, 0][index];
        return { t, pose: p };
      }));
    } else addClip(state, [{ t: 0, pose: pose(state) }, { t: DURATION[state], pose: pose(state) }]);
  }
  for (const from of STATES) for (const to of STATES) if (from !== to) {
    addClip(`transition_${from}_to_${to}`, [{ t: 0, pose: pose(from) }, { t: 0.2, pose: pose(to) }]);
  }
  return { doc, counts };
}

function posedWorld(state) {
  const result = new Map(), p = pose(state);
  for (const [name, parent, translation] of RIG) {
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...translation), new THREE.Quaternion().fromArray(rotation(...p[name])), new THREE.Vector3(1, 1, 1));
    if (parent) matrix.premultiply(result.get(parent));
    result.set(name, matrix);
  }
  return result;
}

/** CPU projection of the actual production meshes for inspectable pose/model sheets. */
function renderMesh(components, { state = 'awaiting_approval', cx, cy, scale = 90, yaw = 0.28, pitch = -0.08, silhouette = false, accentColor }) {
  const world = posedWorld(state);
  const camera = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, yaw, 0));
  const light = new THREE.Vector3(-0.45, 0.72, 0.8).normalize();
  const size = Math.ceil(scale * 8), half = size / 2, pixelScale = scale * 2;
  const pixels = Buffer.alloc(size * size * 4), depth = new Float32Array(size * size).fill(-Infinity);
  for (const component of components) {
    const matrix = new THREE.Matrix4().multiplyMatrices(camera, world.get(component.bone));
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const geometry = component.geometry, p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
    const vertices = Array.from({ length: p.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(p, index).applyMatrix4(matrix));
    const normals = Array.from({ length: p.count }, (_, index) => new THREE.Vector3().fromBufferAttribute(n, index).applyNormalMatrix(normalMatrix));
    const indices = geometry.index?.array ?? Array.from({ length: p.count }, (_, index) => index);
    for (let i = 0; i < indices.length; i += 3) {
      const a = vertices[indices[i]], b = vertices[indices[i + 1]], c = vertices[indices[i + 2]];
      const na = normals[indices[i]], nb = normals[indices[i + 1]], nc = normals[indices[i + 2]];
      const ax = half + a.x * pixelScale, ay = half - a.y * pixelScale;
      const bx = half + b.x * pixelScale, by = half - b.y * pixelScale;
      const ccx = half + c.x * pixelScale, ccy = half - c.y * pixelScale;
      const denominator = (by - ccy) * (ax - ccx) + (ccx - bx) * (ay - ccy);
      if (Math.abs(denominator) < 0.001) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, ccx))), maxX = Math.min(size - 1, Math.ceil(Math.max(ax, bx, ccx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, ccy))), maxY = Math.min(size - 1, Math.ceil(Math.max(ay, by, ccy)));
      const base = new THREE.Color(component.material === 3 ? accentColor ?? COLORS[state] : MATERIAL_COLORS[component.material]);
      for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
        const wa = ((by - ccy) * (px + 0.5 - ccx) + (ccx - bx) * (py + 0.5 - ccy)) / denominator;
        const wb = ((ccy - ay) * (px + 0.5 - ccx) + (ax - ccx) * (py + 0.5 - ccy)) / denominator;
        const wc = 1 - wa - wb;
        if (wa < -0.0001 || wb < -0.0001 || wc < -0.0001) continue;
        const z = wa * a.z + wb * b.z + wc * c.z, offset = py * size + px;
        if (z <= depth[offset]) continue;
        depth[offset] = z;
        const normal = new THREE.Vector3(wa * na.x + wb * nb.x + wc * nc.x, wa * na.y + wb * nb.y + wc * nc.y, wa * na.z + wb * nb.z + wc * nc.z).normalize();
        const shade = component.material === 3 ? 1.20 : (0.40 + Math.max(0, normal.dot(light)) * 0.74) * (1 - Math.max(0, -normal.y) * 0.13);
        const color = silhouette ? new THREE.Color('#dfe6f1') : base.clone().multiplyScalar(shade);
        color.convertLinearToSRGB();
        pixels[offset * 4] = Math.min(255, Math.round(color.r * 255));
        pixels[offset * 4 + 1] = Math.min(255, Math.round(color.g * 255));
        pixels[offset * 4 + 2] = Math.min(255, Math.round(color.b * 255));
        pixels[offset * 4 + 3] = 255;
      }
    }
  }
  return `<image x="${cx - size / 4}" y="${cy - size / 4}" width="${size / 2}" height="${size / 2}" href="data:image/png;base64,${encodePng(size, size, pixels).toString('base64')}"/>`;
}

function encodePng(width, height, pixels) {
  const crc = (data) => {
    let value = 0xffffffff;
    for (const byte of data) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length, 0); body.copy(output, 4); output.writeUInt32BE(crc(body), output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0))]);
}

const text = (x, y, value, size = 16, fill = '#e7edf5', extras = '') => `<text x="${x}" y="${y}" fill="${fill}" font-family="Arial, sans-serif" font-size="${size}" ${extras}>${value}</text>`;
const wrapSvg = (width, height, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="#101720"/>${body}</svg>`;

async function createSheets(components, metrics) {
  await fs.mkdir(path.join(OUTPUT, 'poses'), { recursive: true });
  for (const state of [...STATES, 'neutral']) {
    const graphic = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">${renderMesh(components, { state: state === 'neutral' ? 'awaiting_approval' : state, cx: 128, cy: 132, scale: 61, yaw: 0.20, accentColor: state === 'neutral' ? '#a5b4fc' : undefined })}</svg>`;
    await writePng(sharp(Buffer.from(graphic)), path.join(OUTPUT, 'poses', `${state}.png`));
  }
  const width = 1600, height = 700;
  let body = text(56, 63, 'GIMBAL', 30, '#eef3f9', 'letter-spacing="5"') + text(58, 96, 'NAVIGATOR  /  PRODUCTION CHARACTER  /  ZENITH', 12, '#8e9dac', 'letter-spacing="2"');
  const views = [['FRONT', 0, false], ['THREE-QUARTER', 0.55, false], ['SIDE', 1.57, false], ['SILHOUETTE', 0, true]];
  views.forEach(([label, yaw, silhouette], i) => {
    const cx = 216 + i * 389;
    body += `<line x1="${cx - 161}" x2="${cx + 161}" y1="506" y2="506" stroke="#293542"/>`;
    body += renderMesh(components, { cx, cy: 329, scale: 91, yaw, silhouette });
    body += text(cx, 547, label, 13, '#aebac8', 'text-anchor="middle" letter-spacing="2"');
  });
  body += text(58, 621, 'Matte ceramic  /  brushed bearings  /  recessed emissive eyes  /  three-axis notched rig', 16, '#c0ccd8');
  body += text(58, 654, `${metrics[0].triangles.toLocaleString()} triangles  ·  ${RIG.length} bones  ·  4 draw calls  ·  1024² Basis atlas  ·  Meshopt geometry`, 13, '#7e91a4');
  await writePng(sharp(Buffer.from(wrapSvg(width, height, body))), path.join(OUTPUT, 'model-views.png'));

  let poses = text(56, 63, 'GESTURE, ALIGNMENT, LOCK', 27, '#eef3f9', 'letter-spacing="3"') + text(58, 99, 'One authoritative state. Five deliberately different silhouettes.', 16, '#98aabd');
  const cues = ['Arranging hand · stepped search', 'Open palms · intentional hold', 'Braced stance · clockwise orbit', 'Upright · one nod, then hold', 'Stop palm · locked off-axis'];
  STATES.forEach((state, i) => {
    const cx = 175 + i * 313;
    poses += renderMesh(components, { state, cx, cy: 342, scale: 74, yaw: 0.16 });
    poses += `<circle cx="${cx - 112}" cy="551" r="4" fill="${COLORS[state]}"/>`;
    poses += text(cx - 98, 557, LABELS[state], 17, COLORS[state]);
    poses += text(cx, 589, state, 12, '#9daec0', 'text-anchor="middle"');
    poses += text(cx, 626, cues[i], 12, '#8b9bad', 'text-anchor="middle"');
  });
  await writePng(sharp(Buffer.from(wrapSvg(1600, 700, poses))), path.join(OUTPUT, 'state-poses.png'));

  let production = text(56, 62, 'PRODUCTION MODEL SHEET', 27, '#edf3f9', 'letter-spacing="3"') + text(58, 96, 'Original procedural character  /  rigid skinning  /  product-scale proportions', 15, '#95a8ba');
  production += renderMesh(components, { state: 'verified', cx: 367, cy: 388, scale: 132, yaw: 0.24 });
  const pivots = posedWorld('verified'), rigCamera = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.08, 0.24, 0));
  for (const [name, parent] of RIG.slice(1, 11)) {
    const point = new THREE.Vector3().setFromMatrixPosition(pivots.get(name)).applyMatrix4(rigCamera);
    const start = new THREE.Vector3().setFromMatrixPosition(pivots.get(parent)).applyMatrix4(rigCamera);
    production += `<line x1="${367 + start.x * 132}" y1="${388 - start.y * 132}" x2="${367 + point.x * 132}" y2="${388 - point.y * 132}" stroke="#c4d0e0" stroke-width="1" opacity="0.32" stroke-dasharray="3 4"/><circle cx="${367 + point.x * 132}" cy="${388 - point.y * 132}" r="3.2" fill="#dfe8f2" stroke="#263340" stroke-width="1"/>`;
  }
  const swatches = [['CERAMIC', '#48535f'], ['BEARING METAL', '#a5b1ba'], ['FACE RECESS', '#101b24'], ['PLANNING', COLORS.planning], ['APPROVAL', COLORS.awaiting_approval], ['APPLYING', COLORS.applying], ['VERIFIED', COLORS.verified], ['BLOCKED', COLORS.blocked]];
  swatches.forEach(([label, color], i) => {
    const x = 778 + (i % 4) * 183, y = 159 + Math.floor(i / 4) * 114;
    production += `<rect x="${x}" y="${y}" width="149" height="52" rx="8" fill="${color}" stroke="#384653"/>` + text(x, y + 74, label, 11, '#a6b8c9');
  });
  production += text(778, 427, `PIVOTS  /  ${RIG.length} BONES`, 15, '#e6edf6', 'letter-spacing="2"');
  const lines = ['Root → Torso → Head → eye × 2', 'Torso → shoulder → elbow → mitten × 2', 'Root → magnetic landing foot × 2', 'Root → inner / middle / notched outer ring', 'Outer ring → one progress marker'];
  lines.forEach((line, i) => { production += text(778, 465 + i * 31, line, 15, '#98adbf'); });
  production += text(778, 655, '40% head + face  /  35% torso + limbs  /  25% rig', 14, '#c2d0dd');
  production += text(58, 709, 'State tint is confined to eyes and ring details. Contact shading is baked into vertex color; no live shadow pass.', 14, '#8fa1b4');
  await writePng(sharp(Buffer.from(wrapSvg(1600, 750, production))), path.join(OUTPUT, 'production-sheet.png'));
  // Product avatar uses the actual front-facing character pose at practical sizes.
  for (const size of [64, 96, 256]) {
    const graphic = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${renderMesh(components, { state: 'awaiting_approval', cx: size / 2, cy: size / 2 + size * 0.015, scale: size / 4.0, yaw: 0.2 })}</svg>`;
    await writePng(sharp(Buffer.from(graphic)), path.join(OUTPUT, `avatar-${size}.png`));
  }
}

function iconSvg(color = '#a78bfa', size = 32) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none"><ellipse cx="16" cy="16" rx="10.4" ry="7.1" transform="rotate(-29 16 16)" stroke="${color}" stroke-width="1.5"/><path d="M22.6 4.7A13 13 0 1 0 28.8 18.4" stroke="${color}" stroke-width="2.1" stroke-linecap="round"/><rect x="9.3" y="10.2" width="13.4" height="11.8" rx="5.4" fill="#25313e" stroke="${color}" stroke-width="1.1"/><path d="M13 14.8v3.1M19 14.8v3.1" stroke="${color}" stroke-width="2" stroke-linecap="round"/></svg>`;
}

await fs.mkdir(OUTPUT, { recursive: true });
await MeshoptEncoder.ready; await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const atlas = await createAtlas();
await fs.writeFile(path.join(OUTPUT, 'atlas.png'), atlas);
const metrics = [];
let highGeometry;
for (const lod of [0, 1]) {
  const geometry = buildGeometry(lod);
  if (lod === 0) highGeometry = geometry;
  const { doc, counts } = createDocument(geometry, atlas);
  const triangles = counts.reduce((sum, count) => sum + count, 0);
  const limit = lod === 0 ? 18000 : 8000;
  if (triangles > limit) throw new Error(`LOD${lod} exceeds triangle budget: ${triangles} > ${limit}`);
  await doc.transform(weld(), dedup(), resample(), prune(), ktx2({ isUASTC: false, qualityLevel: 180, generateMipmap: true, enableDebug: false, imageDecoder: async (input) => {
    const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  const filename = lod === 0 ? 'gimbal.glb' : 'gimbal-lod1.glb';
  const binary = await io.writeBinary(doc);
  await fs.writeFile(path.join(OUTPUT, filename), binary);
  if (lod === 0) await fs.writeFile(path.join(OUTPUT, 'atlas.ktx2'), doc.getRoot().listTextures()[0].getImage());
  metrics.push({ lod, file: `/gimbal/${filename}`, triangles, primitiveTriangles: counts, bytes: binary.byteLength });
  console.log(`LOD${lod}: ${triangles} triangles, ${binary.byteLength} bytes`);
}
await fs.mkdir(path.join(OUTPUT, 'basis'), { recursive: true });
for (const file of ['basis_transcoder.js', 'basis_transcoder.wasm', 'README.md']) await fs.copyFile(path.resolve('node_modules/three/examples/jsm/libs/basis', file), path.join(OUTPUT, 'basis', file));
for (const file of ['LICENSE', 'NOTICE']) await fs.copyFile(path.resolve('scripts/gimbal-licenses', file), path.join(OUTPUT, 'basis', file));
await fs.writeFile(path.join(OUTPUT, 'icon.svg'), iconSvg());
await fs.writeFile(path.join(OUTPUT, 'icon-monochrome.svg'), iconSvg('#d9e3ef'));
await fs.writeFile(path.join(OUTPUT, 'icon-grayscale.svg'), iconSvg('#9eabb9'));
for (const size of [16, 24, 32]) await fs.writeFile(path.join(OUTPUT, `icon-${size}.svg`), iconSvg('#a78bfa', size));
const manifest = {
  name: 'Gimbal', role: 'Navigator', version: 1, provenance: 'Original procedural geometry authored for Zenith; see scripts/gimbal-build.mjs.',
  coordinateSystem: { up: '+Y', front: '+Z', target: [0, 0, 0], recommendedCamera: [3, 1, 8], orthographicHeight: 4.2 },
  lods: metrics, skeleton: { bones: RIG.length, hierarchy: RIG.map(([name, parent, translation]) => ({ name, parent, translation })) },
  materials: MATERIAL_NAMES, drawCalls: 4, atlas: { width: 1024, height: 1024, encoding: 'KTX2 Basis ETC1S', file: '/gimbal/atlas.ktx2', source: '/gimbal/atlas.png', shared: true },
  compression: ['EXT_meshopt_compression', 'KHR_texture_basisu'], basisTranscoderPath: '/gimbal/basis/',
  framesPerSecond: 30, shadows: 'Baked analytic contact occlusion in COLOR_0; no real-time shadows required.',
  states: Object.fromEntries(STATES.map((state) => [state, { label: LABELS[state], color: COLORS[state], clip: state, duration: DURATION[state], loop: ['planning', 'applying'].includes(state), reducedMotionClip: `pose_${state}`, holdClip: `pose_${state}`, clampWhenFinished: true }])),
  transitions: STATES.flatMap((from) => STATES.filter((to) => from !== to).map((to) => ({ from, to, clip: `transition_${from}_to_${to}`, duration: 0.2, loop: false }))),
  fallbacks: { icon: '/gimbal/icon.svg', monochrome: '/gimbal/icon-monochrome.svg', avatar: '/gimbal/avatar-96.png', reducedMotion: 'pose_<state>; render once', noWebGL: 'icon and persistent state label' },
  sheets: ['/gimbal/model-views.png', '/gimbal/production-sheet.png', '/gimbal/state-poses.png'],
};
await fs.writeFile(path.join(OUTPUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await createSheets(highGeometry, metrics);
console.log('Created compressed GLBs, atlas, local transcoders, icon fallbacks, and production sheets.');
