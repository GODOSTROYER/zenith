import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone/server.js with only the traced node_modules, which
  // is what the Dockerfile's runner stage copies.
  //
  // `next dev` is unaffected. `next start` still serves normally but now prints
  // "next start does not work with output: standalone" — a warning, not an
  // error (only `output: "export"` throws), so the build-then-start demo path
  // in docs/RUNNING.md keeps working.
  output: "standalone",

  // These Node-only SDKs are pulled in by the provider/action registry. Let
  // Node load their published builds instead of bundling them into each route.
  serverExternalPackages: [
    "@aws-sdk/client-s3",
    "@aws-sdk/client-sqs",
    "@anthropic-ai/sdk",
    // The hosted build recipe and the E2B build runner are Node-only and spawn
    // or import at run time; bundling them into a route would break both.
    "vite",
    "@vitejs/plugin-react",
    "e2b",
  ],

  // `env.ts` defaults ZENITH_DATA to path.join(process.cwd(), ".data"), which
  // the tracer resolves to a real directory — so without this, 32 route traces
  // pull the whole data directory into .next/standalone/.data, state.json,
  // events.jsonl and audit.jsonl included. That both duplicates a developer's
  // database and audit log into build output and lays a trap: the standalone
  // server runs with its own directory as cwd, so an unset ZENITH_DATA there
  // resolves to that build-time copy — a server reading a frozen snapshot.
  //
  // The key is glob-matched against each route ("/api/bootstrap", "/overview"),
  // so it must be "**", not "*" — picomatch's "*" does not cross a slash.
  //
  // KNOWN NOT TO TAKE EFFECT ON WINDOWS (Next 15.3.3): collect-build-traces
  // builds the exclude glob as path.join(dir, exclude), yielding backslashes
  // picomatch cannot match — the adjacent *includes* branch normalises with
  // .replace(/\\/g, "/") and the excludes branch does not. Verified across three
  // builds here; .data is still copied. It applies normally on Linux, which is
  // where Docker and CI build, and the image is protected either way because
  // .dockerignore keeps .data out of the build context entirely.
  outputFileTracingExcludes: {
    "**": [".data/**", ".data-smoke/**", ".data-shots/**"],
  },
};

export default nextConfig;
