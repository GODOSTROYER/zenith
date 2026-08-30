import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep server-only modules out of client bundles.
  serverExternalPackages: [],
  experimental: {
    // Large streamed responses (deployment event streams) stay open.
  },
};

export default nextConfig;
