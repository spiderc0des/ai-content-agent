import type { NextConfig } from 'next';

const config: NextConfig = {
  // postgres.js is Node-only. Keeping it external stops the bundler trying
  // to pull it into an Edge or client bundle.
  serverExternalPackages: ['postgres'],
};

export default config;
