import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  agentRules: false,
  serverExternalPackages: ['pg', 'mysql2', 'mammoth', 'pdfjs-dist', '@aws-sdk/client-s3'],
  experimental: { proxyClientMaxBodySize: "26mb" },
};
export default nextConfig;
