import { useId } from "react";
import type { RevisionPhase, RevisionService } from "./revision-scene";

type Point = [number, number, number];
// The same fixed orthographic studio camera as the WebGL sculpture.
const project = ([x, y, z]: Point) => [325 + (x * 0.8087 - z * 0.5882) * 68, 331 + (x * 0.3153 + z * 0.4335 - y * 0.8441) * 68];
const points = (values: Point[]) => values.map((value) => project(value).join(",")).join(" ");

export function RevisionFallback({ phase, selected, tone }: { phase: RevisionPhase; selected?: RevisionService; tone: "light" | "dark" }) {
  const id = useId().replace(/:/g, "");
  const proposed = phase === "proposed";
  const queueVisible = phase !== "current" && phase !== "restored";
  const queueRed = phase === "proposed" || phase === "applying";
  const queueY = proposed ? 2.08 : 0.43;
  const dark = tone === "dark";
  const line = "#858a7c";
  function block(x: number, y: number, z: number, w: number, h: number, d: number, red = false) {
    const top: Point[] = [[x-w/2,y+h,z-d/2],[x+w/2,y+h,z-d/2],[x+w/2,y+h,z+d/2],[x-w/2,y+h,z+d/2]];
    return <g strokeLinejoin="round" strokeWidth={red ? ".65" : "1.1"}>
      <polygon points={points([[x-w/2,y,z+d/2],[x+w/2,y,z+d/2],top[2],top[3]])} fill={red ? `url(#${id}-redFront)` : `url(#${id}-front)`} stroke={red ? "#a52917" : "#bebfb2"} />
      <polygon points={points([[x+w/2,y,z-d/2],[x+w/2,y,z+d/2],top[2],top[1]])} fill={red ? "#852113" : "#b4b7aa"} stroke={red ? "#852113" : "#b4b7aa"} />
      <polygon points={points(top)} fill={red ? `url(#${id}-red)` : `url(#${id}-top)`} stroke={red ? "#d9432a" : "#f7f5ed"} />
    </g>;
  }
  function route(coords: Point[], red = false) {
    return <polyline points={points(coords)} fill="none" stroke={red ? "#d8583b" : line} strokeWidth={red ? 1.6 : 1.1} />;
  }
  function pin(x: number, z: number, red = false) {
    const [cx,cy] = project([x,0.37,z]);
    return <ellipse key={`${x}-${z}`} cx={cx} cy={cy} rx="3.5" ry="1.7" fill={red ? "#d8583b" : "#a2a498"} stroke="#f6f5ee" strokeWidth="1.4" />;
  }
  function service(x: number, z: number, height: number, worker: boolean) {
    const chosen = selected === (worker ? "atlas-worker" : "atlas-api");
    return <g filter={`url(#${id}-contact)`}>
      {block(x,0.36,z,2.16,height,1.62)}
      {route([[x-.88,.36+height+.02,z-.56],[x+.84,.36+height+.02,z-.56]])}
      {[0,1,2,3,4].map(i => <g key={i}>{route([[x-.66+i*.3,.36+height+.025,z-.25],[x-.66+i*.3,.36+height+.025,z+.24]])}</g>)}
      {route([[x-.72,.36+height+.026,z+.53],[x-.39,.36+height+.026,z+.53]],chosen)}
      {Array.from({length:26},(_,i) => {
        const left=x-.77+i*.043;
        const y=.36+height*.36;
        return <polygon key={i} points={points([[left,y-.052,z+.829],[left+.02,y-.052,z+.829],[left+.02,y+.052,z+.829],[left,y+.052,z+.829]])} fill="#444c40"/>;
      })}
      {[0,1,2].map(i => <g key={i}>{route([[x+.45+i*.12,.36+height*.36,z+.83],[x+.51+i*.12,.36+height*.36,z+.83]])}</g>)}
    </g>;
  }
  return <svg viewBox="0 0 650 580" preserveAspectRatio="xMidYMid meet" focusable="false">
    <defs>
      <linearGradient id={`${id}-top`} x2=".8" y2="1"><stop stopColor="#f1eee5"/><stop offset="1" stopColor="#e4e2d7"/></linearGradient>
      <linearGradient id={`${id}-front`} x2="0" y2="1"><stop stopColor="#d5d4c8"/><stop offset="1" stopColor="#bcbfb0"/></linearGradient>
      <linearGradient id={`${id}-red`} x2="1" y2="1"><stop stopColor="#d63b23"/><stop offset="1" stopColor="#bd2e1b"/></linearGradient>
      <linearGradient id={`${id}-redFront`} x2="0" y2="1"><stop stopColor="#be2f1b"/><stop offset="1" stopColor="#a52617"/></linearGradient>
      <filter id={`${id}-shadow`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14"/></filter>
      <filter id={`${id}-contact`} x="-25%" y="-25%" width="150%" height="150%"><feDropShadow dx="3" dy="5" stdDeviation="3" floodColor="#333b2f" floodOpacity=".2"/></filter>
    </defs>
    <ellipse cx="338" cy="439" rx="210" ry="51" fill={dark ? "#000" : "#626657"} opacity=".22" filter={`url(#${id}-shadow)`}/>
    {block(0,0,-.08,6.7,.32,5.15)}
    {route([[-2.94,.34,2.05],[2.9,.34,2.05],[2.9,.34,-2.14],[-2.94,.34,-2.14],[-2.94,.34,2.05]])}
    {route([[-.44,.345,-1.08],[.22,.345,-1.08],[.22,.345,-.56],[.68,.345,-.56]],queueRed)}
    {route([[-.44,.345,1.02],[.16,.345,1.02],[.16,.345,.72],[.68,.345,.72]],queueRed)}
    {queueVisible && <g>{pin(.68,-.56,queueRed)}{pin(.68,.72,queueRed)}</g>}
    {[[-2.91,-2.09],[2.88,-2.09],[-2.91,2.0],[2.88,2.0]].map(([x,z])=>pin(x,z))}
    <polygon points={points([[.52,.35,-1.18],[2.63,.35,-1.18],[2.63,.35,1.59],[.52,.35,1.59]])} fill="#dadad0" opacity=".45" stroke="#bdbaad" strokeDasharray="4 4"/>
    {service(-1.55,-1.08,1.14,false)}
    {service(-1.55,1.02,.77,true)}
    {proposed && <g opacity=".35" stroke="#d76347" strokeWidth="1" strokeDasharray="3 6">{[.68,2.47].flatMap(x=>[-.99,1.42].map(z=><line key={`${x}-${z}`} x1={project([x,.37,z])[0]} y1={project([x,.37,z])[1]} x2={project([x,queueY,z])[0]} y2={project([x,queueY,z])[1]}/>))}</g>}
    {queueVisible && <g>
      {block(1.57,queueY,.2,2.02,.44,2.64,queueRed)}
      <polygon points={points([[.605,queueY+.46,-1.08],[2.535,queueY+.46,-1.08],[2.535,queueY+.46,1.48],[.605,queueY+.46,1.48]])} fill={queueRed ? "#741d12" : "#a3a798"}/>
      {Array.from({length:14},(_,i)=><g key={i}>{block(.68+i*.137,queueY+.44,.2,.069,.5,2.58,queueRed)}</g>)}
      {route([[.8,queueY+.28,1.526],[2.32,queueY+.28,1.526]],queueRed)}
      <polygon points={points([[2.23,queueY+.03,1.548],[2.41,queueY+.03,1.548],[2.41,queueY+.26,1.548],[2.23,queueY+.26,1.548]])} fill="#bc2f1c"/>
    </g>}
  </svg>;
}
