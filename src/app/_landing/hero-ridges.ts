/**
 * Mountain silhouettes for the opening, generated once from fixed seeds so the
 * server and the client draw the same lines. Ridged noise gives sharp crests
 * with fine rock detail; a pointed summit rises under the zenith point. All
 * three ridges share one 1600 × 1000 drawing that covers the whole opening
 * (`xMidYMax slice`), so the beacon and the mark can sit exactly on the summit.
 */
export const SCENE_WIDTH = 1600;
export const SCENE_HEIGHT = 1000;
/** the x of the zenith point, under the beacon */
export const ZENITH_X = 800;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise over `cells` random lattice points across 0..1. */
function lattice(rand: () => number, cells: number): (u: number) => number {
  const values = Array.from({ length: cells + 2 }, () => rand());
  return (u: number) => {
    const x = u * cells;
    const i = Math.floor(x);
    const f = x - i;
    const t = f * f * (3 - 2 * f);
    return values[i] + (values[i + 1] - values[i]) * t;
  };
}

/** Folds noise into sharp crests. */
const ridged = (n: number) => 1 - Math.abs(2 * n - 1);

export interface RidgeSpec {
  seed: number;
  /** the crest's lowest line, in scene units from the top */
  base: number;
  /** how far the crests rise above `base` */
  amplitude: number;
  /** the summit's extra height under the zenith point, and how wide it is */
  peak: number;
  peakWidth: number;
  /** how much fine rock detail the crest carries */
  roughness: number;
}

export interface RidgeShape {
  /** the closed silhouette, down to the bottom of the scene */
  fill: string;
  /** the crest alone, for rim light */
  crest: string;
  /** the crest's height under the zenith point */
  summit: number;
}

export function ridgeShape({ seed, base, amplitude, peak, peakWidth, roughness }: RidgeSpec, steps = 520): RidgeShape {
  const rand = mulberry32(seed);
  const octaves = [lattice(rand, 7), lattice(rand, 19), lattice(rand, 61), lattice(rand, 173)];
  const points: string[] = [];
  let summit = base;
  for (let s = 0; s <= steps; s++) {
    const u = s / steps;
    const x = u * SCENE_WIDTH;
    const relief = ridged(octaves[0](u)) * 0.5 + ridged(octaves[1](u)) * 0.3 + octaves[2](u) * 0.14 * roughness + octaves[3](u) * 0.06 * roughness;
    const flank = Math.max(0, 1 - Math.abs(x - ZENITH_X) / peakWidth);
    const y = base - amplitude * relief - peak * Math.pow(flank, 1.7);
    if (Math.abs(x - ZENITH_X) < SCENE_WIDTH / steps) summit = y;
    points.push(`${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  const crest = `M${points.join(" L")}`;
  return { crest, fill: `${crest} L${SCENE_WIDTH} ${SCENE_HEIGHT} L0 ${SCENE_HEIGHT} Z`, summit: Math.round(summit * 10) / 10 };
}

export interface Ridge extends RidgeShape {
  id: "far" | "mid" | "near";
  /** parallax depth for the motion hook */
  speed: string;
  /** the rim-light band's thickness */
  band: number;
}

/** Far to near: hazier and higher first, darker and rougher last. */
export const RIDGES: Ridge[] = [
  { id: "far", speed: ".14", band: 12, ...ridgeShape({ seed: 11, base: 858, amplitude: 118, peak: 150, peakWidth: 250, roughness: 0.7 }) },
  { id: "mid", speed: ".08", band: 11, ...ridgeShape({ seed: 23, base: 912, amplitude: 92, peak: 40, peakWidth: 520, roughness: 1 }) },
  { id: "near", speed: ".03", band: 10, ...ridgeShape({ seed: 37, base: 962, amplitude: 66, peak: 0, peakWidth: 1, roughness: 1.3 }) },
];

/** Where the beacon lands: the far ridge's summit. */
export const SUMMIT = { x: ZENITH_X, y: RIDGES[0].summit };
