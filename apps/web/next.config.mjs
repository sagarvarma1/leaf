/** @type {import('next').NextConfig} */
const api = process.env.LEAF_API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`;

const nextConfig = {
  reactStrictMode: false,
  transpilePackages: ["@leaf/shared"],
  devIndicators: false,
  async rewrites() {
    // Same-origin API: the session cookie is set on the web origin and the browser sends it
    // to the API through this proxy. WebSockets go straight to the API port (same host).
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
  webpack(config) {
    // @leaf/shared is TypeScript source that imports "./x.js" (NodeNext style).
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
