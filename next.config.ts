import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
  { key: "X-DNS-Prefetch-Control", value: "off" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["exceljs"],
  experimental: {
    // src/proxy.ts buffers request bodies; allow the 10 MB upload limit plus multipart overhead.
    proxyClientMaxBodySize: "11mb",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  async rewrites() {
    return {
      // Legacy upload URLs (/uploads/...) stored in the database are served through the
      // authenticated file route instead of the public folder.
      beforeFiles: [{ source: "/uploads/:path*", destination: "/api/files/:path*" }],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
