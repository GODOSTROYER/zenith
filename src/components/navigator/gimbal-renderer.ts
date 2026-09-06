import {
  ACESFilmicToneMapping, Color, DirectionalLight, Group, HemisphereLight,
  Mesh, MeshStandardMaterial, OrthographicCamera, Scene, SphereGeometry, Euler, Quaternion,
  SRGBColorSpace, TorusGeometry, WebGLRenderer,
  type BufferGeometry, type Material,
} from "three";
import { GIMBAL_STATE, type GimbalState } from "./gimbal-contract";

export type GimbalMaterial = "alloy" | "porcelain";

export interface GimbalRendererOptions {
  material?: GimbalMaterial;
  state: GimbalState | null;
  reducedMotion: boolean;
  lowPower: boolean;
  onReady: () => void;
  onError: () => void;
}
export interface GimbalRenderer {
  setState(state: GimbalState | null): void;
  setReducedMotion(reducedMotion: boolean): void;
  setLowPower(lowPower: boolean): void;
  setVisible(visible: boolean): void;
  greet(source: "hover" | "tap"): void;
  dispose(): void;
}

const EXPRESSION = {
  neutral: { eye: 1, smile: 0.22, focus: 0, speed: 0.09, tilt: 0, hold: 0, align: 0, block: 0 },
  planning: { eye: 0.84, smile: 0.12, focus: 0.05, speed: 0.12, tilt: 0.08, hold: 0, align: 0, block: 0 },
  awaiting_approval: { eye: 1, smile: 0.3, focus: 0, speed: 0.025, tilt: -0.06, hold: 1, align: 0, block: 0 },
  applying: { eye: 0.72, smile: 0.06, focus: 0.035, speed: 0.14, tilt: 0.12, hold: 0, align: 1, block: 0 },
  verified: { eye: 0.9, smile: 0.65, focus: 0, speed: 0.09, tilt: 0.02, hold: 0, align: 0, block: 0 },
  blocked: { eye: 0.82, smile: -0.16, focus: -0.03, speed: 0.018, tilt: -0.1, hold: 0, align: 0, block: 1 },
};

/** Procedural gyroscope: no model, texture, decoder or animation-clip downloads. */
export async function createGimbalRenderer(host: HTMLElement, options: GimbalRendererOptions): Promise<GimbalRenderer> {
  const porcelain = options.material === "porcelain";
  const renderer = new WebGLRenderer({ alpha: true, antialias: !options.lowPower, powerPreference: "low-power" });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = porcelain ? 1.05 : 1.2;
  renderer.setClearColor(0, 0);
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;pointer-events:none";
  host.append(renderer.domElement);
  const scene = new Scene();
  const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
  camera.position.set(0, 0, 8);
  scene.add(new HemisphereLight(porcelain ? 0xfffcf1 : 0xdde9ff, porcelain ? 0x56584b : 0x182032, porcelain ? 2 : 2.3));
  const key = new DirectionalLight(porcelain ? 0xfff7e9 : 0xffeed7, porcelain ? 2.8 : 3.2);
  key.position.set(-3, 4, 5);
  const rim = new DirectionalLight(porcelain ? 0xe8ebdc : 0x9bbcff, porcelain ? 2 : 3);
  rim.position.set(3, -1, -3);
  scene.add(key, rim);
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  function mesh(geometry: BufferGeometry, material: MeshStandardMaterial, name: string) {
    geometries.add(geometry); materials.add(material);
    const object = new Mesh(geometry, material); object.name = name;
    return object;
  }
  const metal = new MeshStandardMaterial(porcelain
    ? { color: 0x919487, metalness: 0.28, roughness: 0.5 }
    : { color: 0x8e9db4, metalness: 0.72, roughness: 0.32 });
  const shell = new MeshStandardMaterial(porcelain
    ? { color: 0xf4f3ee, metalness: 0.06, roughness: 0.3 }
    : { color: 0x364154, metalness: 0.65, roughness: 0.32 });
  const glass = new MeshStandardMaterial(porcelain
    ? { color: 0x20211f, metalness: 0.04, roughness: 0.38 }
    : { color: 0x080e19, metalness: 0.26, roughness: 0.23 });
  const gold = new MeshStandardMaterial(porcelain
    ? { color: 0xf4f3ee, emissive: 0xe7e2ce, emissiveIntensity: 0.22, roughness: 0.46 }
    : { color: 0xffd69c, emissive: 0xd3a05c, emissiveIntensity: 0.7, roughness: 0.4 });
  const accent = new MeshStandardMaterial({ color: 0xb89cff, emissive: 0xb89cff, emissiveIntensity: porcelain ? 0.12 : 0.38, metalness: porcelain ? 0.08 : 0.35, roughness: porcelain ? 0.48 : 0.4 });
  const sphere = new SphereGeometry(1, options.lowPower ? 24 : 40, 24);
  const face = new Group(); face.name = "Face"; scene.add(face);
  const head = mesh(sphere, shell, "Head"); head.scale.set(0.65, 0.54, 0.39); face.add(head);
  const visor = mesh(sphere, glass, "Visor"); visor.scale.set(0.58, 0.44, 0.23); visor.position.z = 0.25; face.add(visor);
  const eyes = [-1, 1].map((side, index) => {
    const eye = mesh(sphere, gold, index === 0 ? "LeftEye" : "RightEye");
    eye.position.set(side * 0.205, 0.055, 0.473); eye.scale.set(0.066, 0.112, 0.025); face.add(eye); return eye;
  });
  const mouth = mesh(new TorusGeometry(0.112, 0.013, 6, 24, Math.PI), gold, "Mouth");
  mouth.rotation.z = Math.PI; mouth.position.set(0, -0.14, 0.48); face.add(mouth);
  const rings = [1.02, 1.36, 1.69].map((radius, index) => {
    const pivot = new Group(); pivot.name = `Orbit${index}`;
    pivot.add(mesh(new TorusGeometry(radius, index === 1 ? 0.025 : 0.021, 8, options.lowPower ? 64 : 112), metal, `Ring${index}`));
    // Inlaid arcs make axial rotation legible without bright particles or trails.
    pivot.add(mesh(new TorusGeometry(radius, 0.025, 6, 20, 0.38), accent, `Inlay${index}`));
    scene.add(pivot); return pivot;
  });
  let state = options.state;
  let target = EXPRESSION[state ?? "neutral"];
  const current = { ...target };
  const targetColor = new Color();
  let visible = true, sized = false, disposed = false, ready = false;
  let reduced = options.reducedMotion;
  let frame: number | null = null, lastTime: number | null = null, accumulated = 0;
  let elapsed = 0, orbit = 0, impulse = 0, energy = 0;
  let nextBlink = 5 + Math.random() * 6;
  let gesture: { kind: "wink" | "blink" | "notice"; time: number } | null = null;
  let nextGreeting = 0;
  // Incommensurate frequencies never follow a short repeating clip.
  const seed = Math.random() * Math.PI * 2;
  let lowPower = options.lowPower;
  let interval = 1 / (lowPower ? 20 : 30);
  const poseEuler = new Euler();
  const poseQuaternion = new Quaternion();

  function refreshAccent() {
    targetColor.set(getComputedStyle(host).getPropertyValue("--gimbal-accent").trim() || (state ? GIMBAL_STATE[state].color : "#a6a7cb"));
    if (reduced || !ready) { accent.color.copy(targetColor); accent.emissive.copy(targetColor); }
  }
  function pose(dt = 0, preserveRings = false) {
    rings.forEach((ring, index) => {
      const p = orbit * (0.65 + index * 0.19);
      const free = 1 - current.hold - current.block;
      const exploreX = [0.38, -0.65, 0.92][index] + Math.sin(p * 0.71 + seed + index * 2) * 0.32;
      const exploreY = [-0.5, 0.48, 0.2][index] + Math.sin(p * 0.93 + index * 1.7) * 0.48;
      poseEuler.set(
        free * (exploreX * (1 - current.align) + (0.55 + index * 0.12) * current.align)
          + current.hold * (0.48 + index * 0.07) + current.block * [0.18, 1.18, -0.2][index] + current.tilt,
        free * (exploreY * (1 - current.align) + 0.32 * current.align)
          + current.hold * -0.38 + current.block * [-0.45, 0.12, 0.65][index],
        free * (index * 1.08 + p * (index === 1 ? -0.72 : 0.6) * (1 - current.align) + orbit * current.align)
          + current.hold * (0.2 + index * 0.12) + current.block * [0.25, -0.65, 1.1][index],
      );
      poseQuaternion.setFromEuler(poseEuler);
      if (preserveRings) return;
      if (!ready || reduced) ring.quaternion.copy(poseQuaternion);
      else if (dt > 0) ring.quaternion.rotateTowards(poseQuaternion, dt * 0.28);
    });
    const t = gesture ? Math.min(gesture.time / (gesture.kind === "notice" ? 1.4 : 0.9), 1) : 0;
    const envelope = Math.sin(Math.PI * t) ** 2;
    const close = gesture && gesture.kind !== "notice" ? Math.sin(Math.PI * Math.min(t / 0.65, 1)) ** 4 : 0;
    eyes.forEach((eye, i) => {
      eye.scale.y = 0.112 * current.eye * (1 - (i === 0 || gesture?.kind === "blink" ? close * 0.92 : 0));
      eye.position.x = (i === 0 ? -0.205 : 0.205) + current.focus + (gesture?.kind === "notice" ? 0.018 * envelope : 0);
    });
    mouth.scale.y = current.smile + (gesture?.kind === "wink" ? envelope * 0.15 : 0);
    face.rotation.y = current.focus * 0.5 + (reduced ? 0 : Math.sin(elapsed * 0.27 + seed) * 0.025);
    face.rotation.z = gesture ? -0.035 * envelope : 0;
    if (gesture && t === 1) { gesture = null; delete host.dataset.gimbalGesture; }
  }
  function render() {
    if (disposed || !visible || !sized) return;
    try {
      renderer.render(scene, camera);
      if (!ready) { ready = true; options.onReady(); }
    } catch { fail(); }
  }
  function stop() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null; lastTime = null; accumulated = 0;
  }
  function request() {
    if (frame === null && !disposed && visible && sized && !reduced) frame = requestAnimationFrame(tick);
  }
  function tick(now: number) {
    frame = null;
    if (disposed || !visible || !sized || reduced) return;
    if (lastTime === null) lastTime = now;
    accumulated += Math.min((now - lastTime) / 1000, 0.1); lastTime = now;
    if (accumulated >= interval) {
      const dt = Math.floor(accumulated / interval) * interval; accumulated -= dt;
      elapsed += dt;
      // Filtered pulse rises gently, then decays over seconds. Interruptions never
      // reset orbit phase, angle, color or expression to a canonical pose.
      impulse *= Math.exp(-dt / 1.8);
      energy += (impulse - energy) * (1 - Math.exp(-dt / 0.65));
      const blend = 1 - Math.exp(-dt / 1.2);
      for (const key of Object.keys(current) as (keyof typeof current)[]) current[key] += (target[key] - current[key]) * blend;
      orbit += dt * (current.speed + energy * 0.12);
      accent.color.lerp(targetColor, blend); accent.emissive.copy(accent.color);
      if (!gesture && elapsed >= nextBlink) {
        gesture = { kind: state === "blocked" || state === "applying" || Math.random() < 0.75 ? "blink" : "wink", time: 0 };
        host.dataset.gimbalGesture = gesture.kind;
        nextBlink = elapsed + 5 + Math.random() * 7;
      }
      if (gesture) gesture.time += dt;
      pose(dt); render();
    }
    request();
  }
  function resize() {
    if (disposed) return;
    const width = host.clientWidth, height = host.clientHeight;
    sized = width > 0 && height > 0;
    if (!sized) { stop(); return; }
    const aspect = width / height, half = Math.max(1.96, 1.96 / aspect);
    camera.left = -half * aspect; camera.right = half * aspect; camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, lowPower ? 1 : 1.5));
    renderer.setSize(width, height, false); render(); request();
  }
  function dispose() {
    if (disposed) return;
    disposed = true; stop(); gesture = null; delete host.dataset.gimbalGesture;
    observer?.disconnect(); themeObserver?.disconnect();
    window.removeEventListener("resize", resize);
    renderer.domElement.removeEventListener("webglcontextlost", contextLost);
    geometries.forEach((geometry) => geometry.dispose()); materials.forEach((material) => material.dispose());
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  }
  function fail() { if (!disposed) { dispose(); options.onError(); } }
  function contextLost(event: Event) { event.preventDefault(); fail(); }
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
  const themeObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(() => { refreshAccent(); render(); });
  observer?.observe(host);
  themeObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  window.addEventListener("resize", resize);
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  refreshAccent(); pose(); resize();
  return {
    setState(next) {
      if (disposed || state === next) return;
      state = next; target = EXPRESSION[state ?? "neutral"]; refreshAccent();
      if (reduced || !visible) { Object.assign(current, target); impulse = energy = 0; pose(); render(); }
      else impulse = 1;
      request();
    },
    setReducedMotion(next) {
      if (disposed || reduced === next) return;
      reduced = next; stop(); gesture = null; delete host.dataset.gimbalGesture;
      if (reduced) Object.assign(current, target);
      impulse = energy = 0; refreshAccent(); pose(0, true); render(); request();
    },
    setLowPower(next) {
      if (disposed || lowPower === next) return;
      lowPower = next; interval = 1 / (lowPower ? 20 : 30);
      stop(); resize();
    },
    setVisible(next) {
      if (disposed || visible === next) return;
      visible = next; stop();
      // Pause phase and expressions offscreen; never fast-forward missed motion.
      if (visible) resize();
    },
    greet(source) {
      if (disposed || reduced || !visible || !sized || elapsed < nextGreeting) return;
      gesture = { kind: source === "hover" ? "notice" : state === "blocked" || state === "applying" ? "blink" : "wink", time: 0 };
      host.dataset.gimbalGesture = gesture.kind;
      nextGreeting = elapsed + (source === "hover" ? 0.3 : 2.5);
      nextBlink = elapsed + 5 + Math.random() * 7;
      request();
    },
    dispose,
  };
}
