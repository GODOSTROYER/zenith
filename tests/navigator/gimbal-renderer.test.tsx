import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mesh, MeshStandardMaterial, type Scene } from "three";
import { GIMBAL_STATE } from "@/components/navigator/gimbal-contract";
import { createGimbalRenderer, type GimbalRenderer } from "@/components/navigator/gimbal-renderer";

const mocks = vi.hoisted(() => ({ render: vi.fn(), dispose: vi.fn(), pixelRatio: vi.fn(), context: vi.fn() }));
vi.mock("three", async (importOriginal) => ({
  ...await importOriginal<typeof import("three")>(),
  WebGLRenderer: class {
    constructor(options: unknown) { mocks.context(options); }
    domElement = document.createElement("canvas");
    render = mocks.render;
    dispose = mocks.dispose;
    setPixelRatio = mocks.pixelRatio;
    setClearColor() {}
    setSize() {}
    forceContextLoss() {}
  },
}));

describe("living gyroscope lifecycle", () => {
  let host: HTMLElement, runtime: GimbalRenderer | undefined, scene: Scene;
  let time: number, frameNumber: number, frames: Map<number, FrameRequestCallback>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    host = document.createElement("div");
    Object.defineProperties(host, { clientWidth: { value: 144 }, clientHeight: { value: 144 } });
    document.body.append(host);
    time = frameNumber = 0; frames = new Map();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameNumber, callback); return frameNumber; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("fetch", vi.fn());
    mocks.render.mockImplementation((value: Scene) => { scene = value; });
  });
  afterEach(() => {
    runtime?.dispose(); runtime = undefined; host.remove();
    vi.restoreAllMocks(); vi.unstubAllGlobals();
  });
  function advance(ms: number) {
    const end = time + ms;
    while (time < end) {
      time += 1000 / 60;
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((callback) => callback(time));
    }
  }
  async function mount(state: Parameters<typeof createGimbalRenderer>[1]["state"] = null, reducedMotion = false) {
    const onReady = vi.fn(), onError = vi.fn();
    runtime = await createGimbalRenderer(host, { state, reducedMotion, onReady, onError });
    expect(onReady).toHaveBeenCalledOnce(); expect(onError).not.toHaveBeenCalled();
    return { onReady, onError };
  }
  const object = (name: string) => scene.getObjectByName(name)!;
  const accent = () => (object("Inlay0") as Mesh).material as MeshStandardMaterial;

  it("offers porcelain and ink materials while retaining the approved default appearance", async () => {
    await mount("planning", true);
    const headMaterial = () => (object("Head") as Mesh).material as MeshStandardMaterial;
    expect(headMaterial().color.getHexString()).toBe("364154");
    runtime!.dispose();
    runtime = await createGimbalRenderer(host, {
      state: "planning", material: "porcelain", reducedMotion: true,
      onReady: vi.fn(), onError: vi.fn(),
    });
    expect(headMaterial().color.getHexString()).toBe("f4f3ee");
    expect(headMaterial().metalness).toBeLessThan(0.1);
    expect(((object("Visor") as Mesh).material as MeshStandardMaterial).color.getHexString()).toBe("20211f");
    expect(accent().color.getHexString()).toBe(GIMBAL_STATE.planning.color.slice(1));
    expect(frames.size).toBe(0);
  });

  it("renders without asset requests and keeps every ring moving on three axes in calm states", async () => {
    await mount("verified");
    const before = [0, 1, 2].map((i) => object(`Orbit${i}`).rotation.clone());
    mocks.render.mockClear(); advance(1000);
    expect(mocks.render.mock.calls.length).toBeGreaterThanOrEqual(55);
    expect(mocks.render.mock.calls.length).toBeLessThanOrEqual(60);
    before.forEach((rotation, i) => {
      const after = object(`Orbit${i}`).rotation;
      for (const axis of ["x", "y", "z"] as const) expect(Math.abs(after[axis] - rotation[axis])).toBeGreaterThan(0.0001);
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(object("Face").position.length()).toBe(0);
  });

  it("preserves the exact visible pose and color through rapid state interruptions", async () => {
    await mount("applying"); advance(630);
    for (const next of ["awaiting_approval", "blocked", "verified"] as const) {
      const before = object("Orbit0").quaternion.clone(), color = accent().color.clone();
      const eye = object("LeftEye").scale.y;
      runtime!.setState(next);
      expect(object("Orbit0").quaternion.angleTo(before)).toBeLessThan(0.000001);
      expect(accent().color.equals(color)).toBe(true);
      expect(object("LeftEye").scale.y).toBe(eye);
      advance(100);
      expect(object("Orbit0").quaternion.angleTo(before)).toBeLessThan(0.04);
    }
    advance(12_000);
    expect(accent().color.getHexString()).toBe(GIMBAL_STATE.verified.color.slice(1));
    expect(object("Mouth").scale.y).toBeCloseTo(0.65, 3);
  });

  it("adds bounded transition energy and settles back into calm motion", async () => {
    await mount("awaiting_approval");
    const z = () => object("Orbit2").rotation.z;
    advance(1000); runtime!.setState("verified"); advance(1000);
    const activeStart = z(); advance(1000); const activeSpeed = Math.abs(z() - activeStart);
    advance(12_000);
    const calmStart = z(); advance(1000); const calmSpeed = Math.abs(z() - calmStart);
    expect(activeSpeed).toBeGreaterThan(calmSpeed * 1.15);
    // The new held approval pose has a larger journey back to free orbit.
    expect(activeSpeed).toBeLessThan(0.6);
    expect(calmSpeed).toBeGreaterThan(0);
  });

  it("pauses offscreen without elapsed-time catchup or restarting the orbit", async () => {
    await mount("planning"); advance(600);
    const before = object("Orbit1").quaternion.clone();
    runtime!.setVisible(false); expect(frames.size).toBe(0);
    advance(60_000); runtime!.setVisible(true);
    expect(object("Orbit1").quaternion.angleTo(before)).toBeLessThan(0.000001);
    advance(100);
    expect(object("Orbit1").quaternion.angleTo(before)).toBeLessThan(0.03);
  });

  it("keeps reduced motion still while expressions and state accents remain accurate", async () => {
    await mount("planning", true);
    expect(frames.size).toBe(0); runtime!.setState("blocked");
    expect(accent().color.getHexString()).toBe(GIMBAL_STATE.blocked.color.slice(1));
    expect(object("Mouth").scale.y).toBeLessThan(0);
    runtime!.greet("tap"); advance(10_000);
    expect(host.dataset.gimbalGesture).toBeUndefined();
    expect(frames.size).toBe(0);
    expect(mocks.pixelRatio).toHaveBeenLastCalledWith(2);
    runtime!.setReducedMotion(false); expect(frames.size).toBe(1);
    runtime!.setReducedMotion(true); expect(frames.size).toBe(0);
  });

  it("always requests antialiasing and supersamples standard-density screens", async () => {
    await mount();
    expect(mocks.context).toHaveBeenCalledWith({ alpha: true, antialias: true, powerPreference: "high-performance" });
    expect(mocks.pixelRatio).toHaveBeenLastCalledWith(2);
  });

  it("retains 3x display detail and bounds oversized drawing buffers", async () => {
    vi.stubGlobal("devicePixelRatio", 3);
    await mount();
    expect(mocks.pixelRatio).toHaveBeenLastCalledWith(3);
    runtime!.dispose();
    const largeHost = document.createElement("div");
    Object.defineProperties(largeHost, { clientWidth: { value: 2000 }, clientHeight: { value: 1000 } });
    runtime = await createGimbalRenderer(largeHost, { state: null, reducedMotion: true, onReady: vi.fn(), onError: vi.fn() });
    expect(mocks.pixelRatio).toHaveBeenLastCalledWith(4096 / 2000);
  });

  it("answers a tap with a tiny wink and prevents repeated gesture restarts", async () => {
    await mount("verified"); runtime!.greet("tap"); advance(280);
    expect(host.dataset.gimbalGesture).toBe("wink");
    expect(object("LeftEye").scale.y).toBeLessThan(object("RightEye").scale.y * 0.4);
    const before = object("LeftEye").scale.y;
    runtime!.greet("tap"); expect(object("LeftEye").scale.y).toBe(before);
    advance(1000); expect(host.dataset.gimbalGesture).toBeUndefined();
    expect(object("LeftEye").scale.y).toBeCloseTo(object("RightEye").scale.y);
  });

  it("settles the current expression when paused mid-transition without moving the rings", async () => {
    await mount("verified");
    runtime!.setState("blocked");
    const before = object("Orbit0").quaternion.clone();
    runtime!.setReducedMotion(true);
    expect(object("Mouth").scale.y).toBeLessThan(0);
    expect(object("Orbit0").quaternion.angleTo(before)).toBeLessThan(0.000001);
    expect(frames.size).toBe(0);
  });

  it("blinks during quiet work without changing state and suppresses gestures in still mode", async () => {
    await mount("blocked"); advance(7000);
    expect(host.dataset.gimbalGesture).toBe("blink");
    runtime!.setReducedMotion(true); advance(20_000);
    expect(host.dataset.gimbalGesture).toBeUndefined();
    expect(object("Mouth").scale.y).toBeLessThan(0);
    expect(frames.size).toBe(0);
  });

  it("updates themed accents in still mode without scheduling frames", async () => {
    host.style.setProperty("--gimbal-accent", "#00aaff");
    await mount("verified", true);
    expect(accent().color.getHexString()).toBe("00aaff");
    host.style.setProperty("--gimbal-accent", "#337755");
    document.documentElement.setAttribute("data-theme", "light");
    await vi.waitFor(() => expect(accent().color.getHexString()).toBe("337755"));
    expect(frames.size).toBe(0); document.documentElement.removeAttribute("data-theme");
  });

  it("releases shared GPU resources once and falls back on context loss", async () => {
    const { onError } = await mount();
    const geometry = vi.spyOn((object("Head") as Mesh).geometry, "dispose");
    const material = vi.spyOn(accent(), "dispose");
    host.querySelector("canvas")!.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(onError).toHaveBeenCalledOnce(); runtime!.dispose();
    expect(geometry).toHaveBeenCalledOnce(); expect(material).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce(); expect(frames.size).toBe(0);
    expect(host.querySelector("canvas")).toBeNull();
  });
});
