import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WebContainer needs SharedArrayBuffer, which needs a cross-origin-
  // isolated document (COOP: same-origin + a COEP mode). Scoped only
  // to the session workspace page, not app-wide, per the proven
  // apostle pattern (same reasoning ports directly: "credentialless"
  // still achieves crossOriginIsolated while loading cross-origin
  // resources - avatars, any future embedded preview - without
  // requiring them to opt in with Cross-Origin-Resource-Policy).
  async headers() {
    const webContainerHeaders = [
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
    ];
    return [
      { source: "/session/:sessionId", headers: webContainerHeaders },
      // Phase 38: the public "Let the World Try It" page also boots its
      // own real WebContainer instance (see publicBoot.ts) - same
      // SharedArrayBuffer requirement, same fix, just a second route.
      { source: "/p/:sessionId", headers: webContainerHeaders },
    ];
  },
};

export default nextConfig;
