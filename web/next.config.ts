import type { NextConfig } from 'next';
import { validateEnvironment } from './src/lib/env';

validateEnvironment(process.env);

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/admin/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, private' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default nextConfig;
