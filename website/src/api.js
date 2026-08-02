// Production: nginx proxies /api/ → specter-auth:8081
// Local dev: set VITE_API_URL=http://localhost:8082 in website/.env.local
import { createApi } from '@spectercoms/shared-web/src/api.js';

export const API_BASE_URL = import.meta.env.VITE_API_URL || "/api";
const shared = createApi(API_BASE_URL);

export const UPLOADS_BASE_URL = shared.UPLOADS_BASE_URL;
export const api = shared.api;
