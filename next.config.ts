import type { NextConfig } from "next";

// Enforced in the browser: the UI may only talk to its own origin (the
// spacecraft gateway). Any accidental CDN, font or analytics request is
// blocked by the browser itself.
const contentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

// Aboard, the gateway serves Supabase's /auth and /rest on the app's own
// origin. A ground demo (e.g. on Vercel) has no gateway, so when this is set
// Next proxies those paths to a hosted Supabase instead. The browser still
// only ever talks to its own origin. Leave unset on flight hardware.
const supabaseProxyTarget = process.env.OMNI_SUPABASE_PROXY_TARGET?.replace(/\/+$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    if (!supabaseProxyTarget) return [];
    return [
      { source: "/auth/v1/:path*", destination: `${supabaseProxyTarget}/auth/v1/:path*` },
      { source: "/rest/v1/:path*", destination: `${supabaseProxyTarget}/rest/v1/:path*` },
    ];
  },
  // ~/package-lock.json exists outside this repo; pin the workspace root.
  turbopack: { root: import.meta.dirname },
  output: "standalone",
  poweredByHeader: false,
  // No sharp / remote image optimisation on flight hardware.
  images: { unoptimized: true },
  async headers() {
    if (process.env.NODE_ENV !== "production") return [];
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
