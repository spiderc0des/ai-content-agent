// vitest stub — Next.js's bundler aliases the real `server-only` package to a
// no-op when bundling server code, and to a throwing stub only in a client
// bundle. Plain Vite/vitest has no such aliasing, so the real package would
// throw unconditionally. This mirrors what Next actually does for tests.
export default undefined;
