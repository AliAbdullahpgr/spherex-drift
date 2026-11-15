/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  async rewrites() {
    // Preview builds also need the API when NEXT_PUBLIC_API_URL isn't configured.
    // Proxying through this origin avoids requiring CORS for every preview URL.
    const origin = (process.env.SPHEREX_API_ORIGIN ||
      (process.env.VERCEL ? "https://spherex-drift-api.vercel.app" : "http://127.0.0.1:8000"))
      .replace(/\/$/, "");
    return [{ source: "/api/:path*", destination: `${origin}/:path*` }];
  },
};
