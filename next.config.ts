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
    return [
      {
        source: "/session/:sessionId",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
        ],
      },
    ];
  },
};

export default nextConfig;
