/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  // 并行开发时可用 NEXT_DIST_DIR 隔离构建目录，避免多个 next 进程互相清空 .next
  distDir: process.env.NEXT_DIST_DIR || '.next',
};

export default nextConfig;
