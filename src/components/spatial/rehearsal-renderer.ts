import {
  ACESFilmicToneMapping, BufferGeometry, Color, CylinderGeometry, DirectionalLight,
  Float32BufferAttribute, Group, HemisphereLight, Line, LineBasicMaterial, Mesh,
  MeshStandardMaterial, OrthographicCamera, PCFShadowMap, PlaneGeometry, Scene,
  ShadowMaterial, SRGBColorSpace, WebGLRenderer, type Material,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { RehearsalModel, RehearsalNode } from "./rehearsal-model";

export interface RehearsalState { model: RehearsalModel; view: "current" | "proposed"; reducedMotion: boolean; light: boolean }
export interface RehearsalRenderer { setState(state: RehearsalState): void; setVisible(visible: boolean): void; dispose(): void }

/** One finite, demand-rendered scene. No synthetic topology or execution state. */
export function createRehearsalRenderer(host: HTMLElement, initial: RehearsalState & { lowPower: boolean; onError(): void }): RehearsalRenderer {
  const renderer = new WebGLRenderer({ antialias: !initial.lowPower, alpha: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, initial.lowPower ? 1 : 1.5));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.shadowMap.enabled = !initial.lowPower;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.style.cssText = "width:100%;height:100%;display:block;pointer-events:none";
  host.appendChild(renderer.domElement);
  const scene = new Scene();
  const camera = new OrthographicCamera(-5, 5, 3.5, -3.5, .1, 40);
  camera.position.set(8, 11, 12);
  camera.lookAt(0, .1, 0);
  const ambient = new HemisphereLight(0xfffcf3, 0x777d6b, 1.65);
  const key = new DirectionalLight(0xfffaf0, 3);
  key.position.set(-4, 9, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  Object.assign(key.shadow.camera, { left: -7, right: 7, top: 6, bottom: -6, far: 25 });
  key.shadow.normalBias = .025;
  key.shadow.bias = -.0002;
  const fill = new DirectionalLight(0xe4eced, .8);
  fill.position.set(5, 3, -5);
  scene.add(ambient, key, fill);

  const materials = new Set<Material>();
  const material = (color: number, roughness = .42, metalness = .035) => {
    const value = new MeshStandardMaterial({ color, roughness, metalness }); materials.add(value); return value;
  };
  const porcelain = material(0xeee9db);
  const cap = material(0xf8f4e8, .32);
  const seam = material(0xb0b1a1, .55, .14);
  const ink = material(0x454b40, .5, .2);
  const steel = material(0x878e7a, .27, .55);
  const oxide = material(0xbe3e25, .45, .04);
  oxide.toneMapped = false;
  const geometries = new Set<BufferGeometry>();
  const track = <T extends BufferGeometry>(value: T): T => { geometries.add(value); return value; };
  const rounded = track(new RoundedBoxGeometry(1, 1, 1, 2, .065));
  const cylinder = track(new CylinderGeometry(.43, .43, .22, initial.lowPower ? 16 : 32));
  const screw = track(new CylinderGeometry(.025, .025, .014, 10));
  function box(parent: Group | Scene, width: number, height: number, depth: number, x: number, y: number, z: number, finish = porcelain) {
    const mesh = new Mesh(rounded, finish); mesh.scale.set(width, height, depth); mesh.position.set(x, y, z);
    mesh.castShadow = true; mesh.receiveShadow = true; parent.add(mesh); return mesh;
  }
  const chassis = new Group(); scene.add(chassis);
  const substrate = box(chassis, 7.3, .18, 5.3, 0, -.15, 0);
  box(chassis, 7.12, .04, 5.12, 0, -.26, 0, seam);
  for (const x of [-3.38, 3.38]) for (const z of [-2.36, 2.36]) {
    const pin = new Mesh(screw, steel); pin.position.set(x, -.052, z); chassis.add(pin);
  }
  const groundMaterial = new ShadowMaterial({ color: 0x252a20, opacity: .2 }); materials.add(groundMaterial);
  const ground = new Mesh(track(new PlaneGeometry(100, 100)), groundMaterial);
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.29; ground.receiveShadow = true; scene.add(ground);
  const nodeGroup = new Group(); scene.add(nodeGroup);
  const wireGroup = new Group(); scene.add(wireGroup);
  const normalWire = new LineBasicMaterial({ color: 0x838978, transparent: true, opacity: .8 });
  const activeWire = new LineBasicMaterial({ color: 0xbe3e25 }); activeWire.toneMapped = false;
  materials.add(normalWire); materials.add(activeWire);
  const modules = new Map<string, { group: Group; accent: Mesh; label: HTMLSpanElement; node: RehearsalNode; from: number; target: number }>();
  const wires: { line: Line; from: string; to: string }[] = [];
  let state = initial;
  let signature = "";
  let visible = true;
  let disposed = false;
  let frame = 0;
  let started = 0;

  function clearWires() {
    for (const wire of wires) wire.line.geometry.dispose();
    wires.length = 0; wireGroup.clear();
  }
  function topology() {
    const nextSignature = JSON.stringify(state.model.nodes.map(({ id, kind, x, z }) => [id, kind, x, z]));
    if (signature === nextSignature) return;
    signature = nextSignature;
    modules.forEach((assembly) => assembly.label.remove()); modules.clear(); nodeGroup.clear();
    for (const node of state.model.nodes) {
      const group = new Group(); group.position.set(node.x, 0, node.z); nodeGroup.add(group);
      box(group, 1.23, .075, 1.13, 0, .025, 0, seam);
      box(group, 1.12, .075, 1.02, 0, .09, 0, porcelain);
      if (["postgres", "redis", "object_store"].includes(node.kind)) {
        for (let tier = 0; tier < 3; tier++) {
          const disk = new Mesh(cylinder, tier === 2 ? cap : porcelain);
          disk.position.y = .29 + tier * .18; disk.castShadow = disk.receiveShadow = true; group.add(disk);
        }
      } else if (node.kind === "route") {
        box(group, 1.0, .16, .72, 0, .22, 0, cap);
        for (let port = 0; port < 4; port++) box(group, .13, .05, .015, -.31 + port * .21, .22, .367, ink);
      } else {
        const layers = node.kind === "queue" ? 3 : 2;
        for (let tier = 0; tier < layers; tier++) {
          box(group, 1, .20, .80, 0, .24 + tier * .23, 0, tier === layers - 1 ? cap : porcelain);
          for (let vent = 0; vent < 5; vent++) box(group, .085, .026, .012, -.30 + vent * .12, .24 + tier * .23, .406, ink);
        }
        box(group, .84, .025, .67, 0, .16 + layers * .23, 0, seam);
      }
      const accent = box(group, .38, .028, .10, .20, .146, .40, seam);
      const label = document.createElement("span");
      label.setAttribute("aria-hidden", "true");
      label.style.cssText = "position:absolute;transform:translate(-50%,-50%);font:10px var(--font-mono);color:var(--ink);background:var(--bg2);padding:1px 4px;border:1px solid var(--line);border-radius:2px;pointer-events:none";
      host.appendChild(label);
      modules.set(node.id, { group, accent, label, node, from: 0, target: 0 });
    }
  }
  function configure() {
    topology(); clearWires();
    for (const [id, assembly] of modules) {
      assembly.node = state.model.nodes.find((node) => node.id === id)!;
      assembly.group.visible = assembly.node[state.view];
      assembly.label.style.display = assembly.group.visible ? "block" : "none";
      assembly.label.textContent = String(state.model.allNodes.findIndex((node) => node.id === id) + 1).padStart(2, "0");
      const selected = state.model.selectedNodes.includes(id);
      assembly.label.style.borderColor = selected ? "var(--signal)" : "var(--line)";
      assembly.accent.material = selected ? oxide : seam;
      assembly.from = assembly.group.position.y;
      assembly.target = state.view === "proposed" && selected && assembly.node.affected ? .43 : 0;
    }
    for (const binding of state.model.bindings) {
      const value = binding[state.view];
      if (!value || !modules.get(value.from)?.group.visible || !modules.get(value.to)?.group.visible) continue;
      const geometry = new BufferGeometry(); geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(18), 3));
      const highlighted = binding.id === state.model.selectedId || state.model.selectedNodes.includes(value.from) || state.model.selectedNodes.includes(value.to);
      const line = new Line(geometry, highlighted ? activeWire : normalWire); wireGroup.add(line);
      wires.push({ line, from: value.from, to: value.to });
    }
    groundMaterial.opacity = state.light ? .20 : .34;
    substrate.material = porcelain;
    activeWire.color.set(state.light ? 0xbe3e25 : 0xff886c);
    oxide.color.copy(activeWire.color);
    normalWire.color.copy(new Color(state.light ? 0x838978 : 0x9fa791));
    started = performance.now();
  }
  function paint(now: number) {
    frame = 0;
    if (disposed || !visible) return;
    const t = state.reducedMotion ? 1 : Math.min(1, (now - started) / 380);
    const eased = 1 - Math.pow(1 - t, 4);
    for (const assembly of modules.values()) {
      assembly.group.position.y = assembly.from + (assembly.target - assembly.from) * eased;
      const position = assembly.group.position.clone(); position.y += .92; position.project(camera);
      assembly.label.style.left = `${(position.x * .5 + .5) * host.clientWidth}px`;
      assembly.label.style.top = `${(-position.y * .5 + .5) * host.clientHeight}px`;
    }
    for (const wire of wires) {
      const a = modules.get(wire.from)!.group.position, b = modules.get(wire.to)!.group.position;
      const mid = (a.z + b.z) / 2;
      const array = wire.line.geometry.attributes.position.array as Float32Array;
      array.set([a.x, a.y + .04, a.z, a.x, -.025, a.z, a.x, -.025, mid, b.x, -.025, mid, b.x, -.025, b.z, b.x, b.y + .04, b.z]);
      wire.line.geometry.attributes.position.needsUpdate = true;
      wire.line.geometry.computeBoundingSphere();
    }
    renderer.render(scene, camera);
    if (t < 1 && [...modules.values()].some((assembly) => assembly.from !== assembly.target)) frame = requestAnimationFrame(paint);
  }
  function requestPaint() { if (!frame && !disposed && visible) frame = requestAnimationFrame(paint); }
  function resize() {
    const width = Math.max(1, host.clientWidth), height = Math.max(1, host.clientHeight);
    renderer.setSize(width, height, false);
    const aspect = width / height;
    const span = Math.max(3.9, 5.0 / aspect);
    camera.left = -span * aspect; camera.right = span * aspect; camera.top = span; camera.bottom = -span;
    camera.updateProjectionMatrix(); requestPaint();
  }
  const observer = new ResizeObserver(resize); observer.observe(host);
  const lost = (event: Event) => { event.preventDefault(); initial.onError(); };
  renderer.domElement.addEventListener("webglcontextlost", lost);
  configure(); resize();
  return {
    setState(next) { state = { ...initial, ...next }; configure(); requestPaint(); },
    setVisible(next) { visible = next; if (!visible) { cancelAnimationFrame(frame); frame = 0; } else requestPaint(); },
    dispose() {
      if (disposed) return; disposed = true;
      cancelAnimationFrame(frame); observer.disconnect(); clearWires();
      modules.forEach((assembly) => assembly.label.remove());
      renderer.domElement.removeEventListener("webglcontextlost", lost);
      geometries.forEach((geometry) => geometry.dispose()); materials.forEach((value) => value.dispose());
      key.shadow.map?.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    },
  };
}
