import type { NextConfig } from 'next';

const config: NextConfig = {
  devIndicators: false,
  webpack(config, { isServer, webpack }) {
    if (!isServer) config.plugins.push(new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }));
    return config;
  },
};

export default config;
