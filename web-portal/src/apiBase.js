// The identity-node base URL, baked in at build time from VITE_API_URL
// (web-portal/.env). Kept in its own module so api.js, auth/tokenStore.js and
// useEventStream.js share one definition without importing each other.
export const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8082";
