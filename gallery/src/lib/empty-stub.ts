// Stub for local build to prevent bundling cloudflare:workers in Node.js
export function createDialect() {
  throw new Error('D1 dialect is not available in Node.js local environment.');
}
