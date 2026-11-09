// Production: nginx proxies /api/ → specter-auth:8081
// Local dev: set VITE_API_URL=http://localhost:8082 in website/.env.local
import { createApi } from '@spectercoms/shared-web/src/api.js';
import { createSession } from './auth/session.js';

export const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";

// The user session (see auth/session.js): requests get a token that's
// refreshed near expiry, and a 401 gets one shared refresh + one retry
// instead of clearing the session outright.
export const session = createSession({ apiBase: API_BASE_URL });
const shared = createApi(API_BASE_URL, session);

export const UPLOADS_BASE_URL = shared.UPLOADS_BASE_URL;
export const api = shared.api;
