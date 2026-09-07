/**
 * Hosted contracts barrel — the one import every hosted workstream uses.
 *
 * This directory is pure: types, zod schemas, constants and tiny pure helpers.
 * No `node:` imports, no store, no env. That is what lets the browser fixture,
 * the edge middleware and the server share it.
 *
 * SPINE FILE — owned by the integrator.
 */
export * from "./errors";
export * from "./types";
export * from "./tracker-v1";
export * from "./source-v1";
export * from "./interfaces";
