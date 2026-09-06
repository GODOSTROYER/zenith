import {
  ACESFilmicToneMapping, CanvasTexture, Color, CylinderGeometry, DirectionalLight,
  Group, HemisphereLight, Mesh, MeshBasicMaterial, MeshStandardMaterial,
  OrthographicCamera, PCFSoftShadowMap, PlaneGeometry, Scene, ShadowMaterial,
  SRGBColorSpace, WebGLRenderer,
  type BufferGeometry, type Material,
} from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { RevisionPhase, RevisionService } from "./revision-scene";

interface State {
  phase: RevisionPhase;
  selected?: RevisionService;
  tone: "light" | "dark";
  reducedMotion: boolean;
}
interface Options extends State {
  lowPower: boolean;
  onReady: () => void;
  onError: () => void;
}
export interface RevisionRenderer {
  setState(state: State): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** Geometry, illumination and one finite revision transition; no downloaded assets. */
export function createRevisionRenderer(host: HTMLElement, options: Options): RevisionRenderer {
  const renderer = new WebGLRenderer({ alpha: true, antialias: !options.lowPower, powerPreference: "low-power" });
  renderer.setClearColor(0, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = .97;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.domElement.setAttribute("aria-hidden", "true");
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;pointer-events:none";
  host.appendChild(renderer.domElement);

  const scene = new Scene();
  const camera = new OrthographicCamera(-4.8,4.8,4.28,-4.28,.1,40);
  camera.position.set(8,9.35,11);
  camera.lookAt(0,.72,0);
  const ambient = new HemisphereLight(0xfffdf8,0x6c7169,1.42);
  const key = new DirectionalLight(0xfffcf4,2.8);
  key.position.set(-3,8,5);
  key.castShadow = true;
  key.shadow.mapSize.set(options.lowPower ? 512 : 1024, options.lowPower ? 512 : 1024);
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  key.shadow.camera.near = .5;
  key.shadow.camera.far = 24;
  key.shadow.normalBias = .035;
  key.shadow.bias = -.0002;
  key.shadow.radius = 4;
  const fill = new DirectionalLight(0xe9edee,.72);
  fill.position.set(5,4,-6);
  scene.add(ambient,key,fill);

  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures: CanvasTexture[] = [];
  const standard = (color: number, roughness = .48, metalness = .04) => {
    const mat = new MeshStandardMaterial({ color,roughness,metalness });
    materials.add(mat);
    return mat;
  };
  const porcelain = standard(0xe9e5d9,.4,.035);
  const serviceMat = standard(0xf4f0e4,.32,.045);
  const seamMat = standard(0x888b80,.6,.13);
  const recessMat = standard(0xb5b5a8,.71,.08);
  const routeMat = standard(0x797e70,.57,.35);
  const steel = standard(0x646b60,.28,.56);
  const ventMat = standard(0x303a32,.63,.08);
  const redMat = standard(0xa32317,.4,.1);
  const redTop = standard(0xb72b1a,.33,.12);
  const redDetail = standard(0x59190f,.49,.17);
  const revisionTabMat = standard(0xa32317,.36,.1);
  const bindingMat = standard(0xa32317,.48,.14);
  revisionTabMat.toneMapped=false;
  bindingMat.transparent=true;
  const porcelainFinish = { value: 0 };
  // Preserve the saturated oxide pigment under bright studio lighting. ACES's
  // highlight desaturation otherwise turns red pale orange. A uniform smoothly
  // restores normal tone mapping as the recorded object settles into porcelain.
  for(const material of [redMat,redTop,redDetail,bindingMat]) {
    material.onBeforeCompile = (shader) => {
      shader.uniforms.zenithPorcelain = porcelainFinish;
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float zenithPorcelain;")
        .replace("#include <tonemapping_fragment>", `
          #ifdef TONE_MAPPING
            gl_FragColor.rgb = mix(gl_FragColor.rgb, toneMapping(gl_FragColor.rgb), zenithPorcelain);
          #endif
        `);
    };
    material.customProgramCacheKey = () => "zenith-revision-finish-v1";
  }
  const oxideColors = [new Color(0xa32317),new Color(0xb72b1a),new Color(0x59190f)];
  const porcelainColors = [new Color(0xe9e5d9),new Color(0xf4f0e4),new Color(0x9c9f92)];
  // Fine ceramic variation stays below one percent and uses no texture download.
  for(const material of [porcelain,serviceMat]) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", `
        #include <color_fragment>
        float ceramicGrain = fract(sin(dot(floor(vViewPosition * 380.0), vec3(12.9898,78.233,37.719))) * 43758.5453);
        diffuseColor.rgb *= 0.991 + ceramicGrain * 0.009;
      `);
    };
    material.customProgramCacheKey = () => "zenith-ceramic-grain-v1";
  }
  const accent = standard(0xca5234,.38,.18);
  const statusMat = standard(0x73876a,.39,.1);
  statusMat.emissive.set(0x778763);
  statusMat.emissiveIntensity = .13;

  function mesh(geometry: BufferGeometry, material: Material, parent: Group | Scene = scene) {
    geometries.add(geometry);
    materials.add(material);
    const result = new Mesh(geometry,material);
    result.castShadow = true;
    result.receiveShadow = true;
    parent.add(result);
    return result;
  }
  function box(w: number, h: number, d: number, x: number, y: number, z: number, material: Material, radius = .065, parent: Group | Scene = scene) {
    const result = mesh(new RoundedBoxGeometry(w,h,d,2,Math.min(radius,h*.45,w*.45,d*.45)),material,parent);
    result.position.set(x,y,z);
    return result;
  }
  function pin(x: number, y: number, z: number, material = steel, parent: Group | Scene = scene, radius = .045) {
    const result = mesh(new CylinderGeometry(radius,radius,.028,12),material,parent);
    result.position.set(x,y,z);
    return result;
  }
  function route(points: [number,number][], material = routeMat, y = .333, parent: Group | Scene = scene, width = .018) {
    for(let i=1;i<points.length;i++) {
      const [ax,az] = points[i-1], [bx,bz] = points[i];
      const length = Math.hypot(bx-ax,bz-az);
      const trace = box(width,.008,length,(ax+bx)/2,y,(az+bz)/2,material,.003,parent);
      trace.rotation.y = Math.atan2(bx-ax,bz-az);
      trace.castShadow = false;
    }
  }

  const groundMat = new ShadowMaterial({ color: 0x292c24,opacity:.23 });
  const ground = mesh(new PlaneGeometry(200,200),groundMat);
  ground.rotation.x = -Math.PI/2;
  ground.position.y = -.055;
  ground.castShadow = false;

  // A soft, analytic studio contact shadow prevents a floating plinth in either theme.
  const shadowCanvas = document.createElement("canvas");
  shadowCanvas.width = shadowCanvas.height = 128;
  const context = shadowCanvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(64,64,6,64,64,64);
    gradient.addColorStop(0,"rgba(38,41,30,.3)");
    gradient.addColorStop(.55,"rgba(38,41,30,.14)");
    gradient.addColorStop(1,"rgba(38,41,30,0)");
    context.fillStyle = gradient;
    context.fillRect(0,0,128,128);
    const texture = new CanvasTexture(shadowCanvas);
    textures.push(texture);
    const shadow = mesh(new PlaneGeometry(9.2,7.4),new MeshBasicMaterial({ map:texture,transparent:true,depthWrite:false }));
    shadow.rotation.x = -Math.PI/2;
    shadow.position.set(.2,-.035,.3);
    shadow.castShadow = shadow.receiveShadow = false;
  }

  const base = box(6.7,.32,5.15,0,.16,-.08,porcelain,.105);
  base.name = "Revision substrate";
  box(6.42,.038,4.88,0,.018,-.08,seamMat,.018);
  route([[-2.94,2.05],[2.9,2.05],[2.9,-2.14],[-2.94,-2.14],[-2.94,2.05]],recessMat);
  for(const x of [-2.91,2.88]) for(const z of [-2.09,2]) {
    pin(x,.342,z);
    route([[x-.022,z],[x+.022,z]],porcelain,.36,scene,.006);
  }
  // Small die-edge notches and machined copper pads make this an infrastructure object.
  for(let i=0;i<12;i++) box(.05,.045,.045,-2.75+i*.22,.18,2.493,i<3 ? accent : recessMat,.006);
  for(let i=0;i<6;i++) box(.08,.018,.23,2.97,.337,-.66+i*.24,steel,.008);

  const bindingPaths: [number,number][][] = [
    [[-.44,-1.08],[.22,-1.08],[.22,-.56],[.68,-.56]],
    [[-.44,1.02],[.16,1.02],[.16,.72],[.68,.72]],
  ];
  bindingPaths.forEach(path => route(path,routeMat));
  route([[-1.55,-.2],[-1.55,.2]],routeMat);
  route([[-2.7,-1.08],[-2.81,-1.08],[-2.81,1.82],[.2,1.82],[.2,1.02]],recessMat);
  const revisionRoute = new Group();
  scene.add(revisionRoute);
  bindingPaths.forEach(path => {
    route(path,bindingMat,.345,revisionRoute,.027);
    const [x,z] = path[path.length-1];
    pin(x,.36,z,bindingMat,revisionRoute,.042);
  });

  const highlights: Record<RevisionService, MeshStandardMaterial> = {
    "atlas-api": standard(0x86907b), "atlas-worker": standard(0x86907b), "atlas-jobs": redTop,
  };
  function service(x: number, z: number, height: number, name: "atlas-api" | "atlas-worker") {
    const group = new Group(); group.name = name; scene.add(group);
    // Recessed foot, restrained gasket line, and separate ceramic lid.
    box(2.06,.055,1.53,x,.354,z,recessMat,.032,group);
    box(2.16,height,1.62,x,.36+height/2,z,serviceMat,.075,group);
    box(2.163,.017,1.623,x,.36+height-.13,z,seamMat,.006,group);
    box(2.14,.14,1.6,x,.36+height-.055,z,serviceMat,.05,group);
    const y=.36+height+.018;
    route([[x-.85,z-.54],[x+.84,z-.54]],recessMat,y,group,.011);
    for(let i=0;i<6;i++) box(.066,.012,.45,x-.69+i*.275,y,z-.005,seamMat,.005,group);
    box(.25,.018,.052,x-.72,y,z+.53,highlights[name],.015,group);
    for(let i=0;i<3;i++) pin(x+.49+i*.13,y,z+.52,steel,group,.024);
    // A front-facing inset bus and three discrete binding points.
    box(1.69,.13,.018,x,.36+height*.36,z+.812,recessMat,.009,group);
    for(let i=0;i<26;i++) box(.02,.105,.02,x-.77+i*.043,.36+height*.36,z+.829,ventMat,.004,group);
    for(let i=0;i<3;i++) box(.085,.055,.023,x+.45+i*.12,.36+height*.36,z+.83,steel,.007,group);
    box(.04,.04,.023,x+.84,.36+height*.36,z+.83,statusMat,.009,group);
    return group;
  }
  service(-1.55,-1.08,1.14,"atlas-api");
  service(-1.55,1.02,.77,"atlas-worker");

  const slot = new Group(); scene.add(slot);
  box(2.15,.025,2.78,1.57,.328,.2,recessMat,.06,slot);
  box(1.96,.026,2.59,1.57,.34,.2,porcelain,.04,slot);
  for(const x of [.7,2.44]) for(const z of [-.96,1.36]) {
    box(.22,.014,.024,x,.36,z,accent,.004,slot);
    box(.024,.014,.2,x+(x<1 ? -.1:.1),.36,z+(z<0 ? .09:-.09),accent,.004,slot);
  }
  for(let i=0;i<4;i++) pin(1.1+i*.3,.37,.2,steel,slot,.058);

  const guides = new Group(); scene.add(guides);
  const guideMaterial = standard(0xd77c61,.8,0);
  guideMaterial.transparent = true;
  guideMaterial.opacity = .32;
  for(const x of [.7,2.44]) for(const z of [-.96,1.36]) {
    for(let i=0;i<9;i++) box(.012,.075,.012,x,.44+i*.19,z,guideMaterial,.004,guides);
  }

  const queue = new Group(); queue.name = "atlas-jobs"; scene.add(queue);
  queue.position.set(1.57,2.08,.2);
  const queueMaterials = [redMat,redTop,redDetail,revisionTabMat];
  queueMaterials.forEach(mat => { mat.transparent=true; });
  box(1.88,.07,2.5,0,.01,0,redDetail,.035,queue);
  box(2.02,.44,2.64,0,.22,0,redMat,.05,queue);
  box(1.93,.03,2.56,0,.445,0,redDetail,.012,queue);
  // Deep, closely spaced parallel fins are real geometry. Their self-shadow and
  // narrow polished shoulders make the queue legible even at hero scale.
  for(let i=0;i<14;i++) {
    const x=-.89+i*.137;
    box(.069,.5,2.58,x,.69,0,redMat,.014,queue);
    box(.071,.018,2.55,x,.936,0,redTop,.008,queue);
  }
  box(1.58,.014,.018,0,.28,1.326,redDetail,.003,queue);
  box(.18,.23,.026,.75,.145,1.334,revisionTabMat,.012,queue);
  for(let i=0;i<3;i++) box(.09,.05,.018,-.61+i*.16,.14,1.327,redTop,.01,queue);
  for(const x of [-.7,.7]) for(const z of [-1,1]) box(.035,.16,.035,x,-.055,z,redDetail,.009,queue);

  let state: State = options;
  let visible = true, disposed = false, ready = false, sized = false;
  let frame: number | null = null;
  let lastTime: number | null = null;
  let accumulated = 0;
  let progress = 1;
  type Pose = { y: number; opacity: number; guide: number; light: number; finish: number };
  const targetFor = (phase: RevisionPhase): Pose => ({
    y: phase === "proposed" || phase === "restored" ? 2.08 : .43,
    opacity: phase === "current" || phase === "restored" ? 0 : 1,
    guide: phase === "proposed" ? 1 : 0,
    light: phase === "recorded" ? 1 : 0,
    finish: phase === "recorded" || phase === "restored" ? 1 : 0,
  });
  let pose = targetFor(state.phase);
  let from = { ...pose }, target = { ...pose };

  function applyPose() {
    queue.position.y = pose.y;
    queue.visible = pose.opacity > .005;
    queueMaterials.forEach(mat => { mat.opacity = pose.opacity; });
    porcelainFinish.value = pose.finish;
    [redMat,redTop,redDetail].forEach((material,index) => {
      material.color.copy(oxideColors[index]).lerp(porcelainColors[index],pose.finish);
    });
    bindingMat.color.copy(oxideColors[0]).lerp(routeMat.color,pose.finish);
    bindingMat.opacity = pose.opacity;
    guides.visible = pose.guide > .005 && pose.opacity > .005;
    guideMaterial.opacity = .28 * pose.guide * pose.opacity;
    revisionRoute.visible = pose.opacity > .1;
    fill.intensity = (state.tone === "dark" ? .96 : .72) + pose.light*.1;
  }
  function render() {
    if(disposed || !visible || !sized) return;
    try {
      renderer.render(scene,camera);
      if(!ready) { ready=true; options.onReady(); }
    } catch { fail(); }
  }
  function stop() {
    if(frame !== null) cancelAnimationFrame(frame);
    frame=null; lastTime=null; accumulated=0;
  }
  function request() {
    if(frame === null && !disposed && visible && sized && progress<1 && !state.reducedMotion) frame=requestAnimationFrame(tick);
  }
  function tick(time: number) {
    frame=null;
    if(disposed || !visible || !sized) return;
    if(lastTime === null) lastTime=time;
    accumulated += Math.min((time-lastTime)/1000,.1);
    lastTime=time;
    if(accumulated >= 1/30) {
      progress = Math.min(1,progress + accumulated/(state.phase === "restored" ? .85:1.25));
      accumulated=0;
      const ease = progress*progress*progress*(progress*(progress*6-15)+10);
      // Restoration visibly undocks the queue before removing it. Existing
      // services remain anchored; reduced motion still applies the final pose.
      const fadeProgress = state.phase === "restored" ? Math.max(0,(progress-.36)/.64):progress;
      const fadeEase = fadeProgress*fadeProgress*fadeProgress*(fadeProgress*(fadeProgress*6-15)+10);
      pose={ y:from.y+(target.y-from.y)*ease, opacity:from.opacity+(target.opacity-from.opacity)*fadeEase,
        guide:from.guide+(target.guide-from.guide)*ease, light:from.light+(target.light-from.light)*ease,
        finish:from.finish+(target.finish-from.finish)*ease };
      applyPose(); render();
    }
    request();
  }
  function resize() {
    if(disposed) return;
    const width=host.clientWidth, height=host.clientHeight;
    sized=width>0 && height>0;
    if(!sized) { stop(); return; }
    const aspect=width/height;
    const half=Math.max(4.28,4.8/aspect);
    camera.left=-half*aspect; camera.right=half*aspect;
    camera.top=half; camera.bottom=-half;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1,options.lowPower ? 1:1.5));
    renderer.setSize(width,height,false);
    render(); request();
  }
  function setState(next: State) {
    const phaseChanged=next.phase !== state.phase;
    state=next;
    if(phaseChanged) {
      from={...pose}; target=targetFor(next.phase); progress=0;
    }
    if(state.reducedMotion) { pose={...target}; progress=1; stop(); }
    ambient.intensity=state.tone === "dark" ? 1.65:1.42;
    groundMat.opacity=state.tone === "dark" ? .32:.23;
    groundMat.color.set(state.tone === "dark" ? 0x000000:0x292c24);
    for(const name of ["atlas-api","atlas-worker"] as const) {
      highlights[name].color.set(state.selected === name ? 0xe35c39:0x86907b);
    }
    oxideColors[1].set(state.selected === "atlas-jobs" ? 0xbf2d1b:0xb72b1a);
    applyPose(); render(); request();
  }
  function fail() { if(!disposed) { stop(); options.onError(); } }
  function lost(event: Event) { event.preventDefault(); fail(); }
  renderer.domElement.addEventListener("webglcontextlost",lost);
  const observer=new ResizeObserver(resize);
  observer.observe(host);
  applyPose();
  resize();
  setState(options);

  return {
    setState,
    setVisible(next) {
      visible=next;
      if(!next) stop();
      else { render(); request(); }
    },
    dispose() {
      if(disposed) return;
      disposed=true;
      stop(); observer.disconnect();
      renderer.domElement.removeEventListener("webglcontextlost",lost);
      geometries.forEach(geometry=>geometry.dispose());
      materials.forEach(material=>material.dispose());
      textures.forEach(texture=>texture.dispose());
      key.shadow.map?.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      scene.clear();
    },
  };
}
