import { resolve } from "node:path";
import type { NextConfig } from "next";

// The wire protocol lives in ../packages and is shared with the spacecraft
// relay, so the build root is the repository root.
const repoRoot = resolve(process.cwd(), "..");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
};

export default nextConfig;
