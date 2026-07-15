import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow images from finance APIs
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  // Server-side API calls need longer timeout
  serverExternalPackages: ["tesseract.js"],
};

export default nextConfig;
