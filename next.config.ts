import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: [
    "10.26.16.41",
    "192.168.137.1",
    "localhost",
    "127.0.0.1",
  ],

  /**
   * The audit trail stores the requesting client's IP address. In development
   * and behind a reverse proxy we only trust a single hop, so Next.js must be
   * told which header carries the original client address.
   */
  experimental: {
    // Never bundle Prisma's query engine / pg driver into the client.
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },

  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg", "bcryptjs"],

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
