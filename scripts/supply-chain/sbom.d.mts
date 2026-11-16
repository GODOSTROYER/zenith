/* eslint-disable @typescript-eslint/no-explicit-any */
// Types for sbom.mjs (PROD-OPS-09). Documents are plain CycloneDX JSON, so they are loosely typed.
export const SBOM_TOOL: { name: string; version: string };
export function npmPurl(name: string, version: string): string;
export function sriToHex(integrity: string | undefined): string | undefined;
export function npmComponents(lock: any, packageJson: any): { components: any[]; dependencies: { ref: string; dependsOn: string[] }[]; direct: string[] };
export interface GoInfo {
  binary: string;
  goVersion: string;
  path: string | undefined;
  main: { path: string; version: string } | undefined;
  deps: { path: string; version: string; h1?: string; replacedBy?: { path: string; version: string; h1?: string } }[];
  build: Record<string, string>;
}
export function parseGoVersionM(text: string): GoInfo;
export function goPurl(modulePath: string, version: string): string;
export function goComponents(infos: GoInfo[]): { components: any[]; dependencies: { ref: string; dependsOn: string[] }[] };
export function dockerfileComponents(text: string, file: string): any[];
export function imageComponent(name: string, digest: string, file?: string): any;
export function buildSbom(input: {
  lock: any;
  packageJson?: any;
  goInfos?: GoInfo[];
  dockerfiles?: { file: string; text: string }[];
  images?: { name: string; digest: string; file?: string }[];
  version: string;
  commit: string;
  timestamp?: string;
}): any;
export function validateSbom(doc: any): string[];
export function main(argv: string[], stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream): number;
