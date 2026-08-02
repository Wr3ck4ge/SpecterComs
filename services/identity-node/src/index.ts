import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.js';
import orgRoutes from './routes/org.js';
import adminRoutes from './routes/admin.js';
import userRoutes from './routes/user.js';
import friendRoutes from './routes/friend.js';
import downloadRoutes from './routes/download.js';
import sseRoutes from './routes/sse.js';
import dmRoutes from './routes/dm.js';
import abuseRoutes from './routes/abuse.js';
import diagRoutes from './routes/diag.js';
import gameShipsRoutes from './routes/gameShips.js';
import hangarRoutes from './routes/hangar.js';
import stripeWebhookRoutes from './routes/stripeWebhook.js';
import { initDiscovery } from './utils/discovery.js';
import { startBillingConsumer } from './utils/billingConsumer.js';
import { seedPresenceFromDb } from './controllers/channelController.js';
import { startGameDataSyncScheduler } from './utils/gameDataScheduler.js';
import { startPushWatcher } from './jobs/pushWatcher.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// nginx sits in front of this service and sets X-Forwarded-For (see nginx/*.conf) —
// without this, req.ip resolves to nginx's own container IP for every request,
// which would bucket the auth rate limiters below by a single shared key instead
// of by real client IP. `1` = trust exactly one hop (the nginx reverse proxy).
app.set('trust proxy', 1);

// Init NATS Discovery
initDiscovery();
// Start usage metering consumer (data only — BILLING_ENFORCE=false by default)
startBillingConsumer();
// Daily refresh of Star Citizen ship/component data from fleetyards.net +
// scunpacked-data, independent of request traffic (see gameDataScheduler.ts)
startGameDataSyncScheduler();
// Polls node health for offline/overloaded transitions and pushes to
// registered admin devices via FCM — no-ops quietly if FIREBASE_SERVICE_ACCOUNT_PATH
// isn't configured (see utils/pushService.ts).
startPushWatcher();

// Middleware
app.use(helmet());

// CORS: explicit allowlist instead of the wide-open default (which reflected
// any Origin back for every route, including billing/admin/moderation).
// CORS_ALLOWED_ORIGINS is a comma-separated override for prod/staging; the
// defaults cover the marketing site (FRONTEND_URL, same default used by
// emailService.ts), the packaged Tauri desktop app's webview origins, and
// local dev servers for both frontends.
const DEFAULT_ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'https://spectercoms.net',
  'https://spectercoms.net',
  'https://www.spectercoms.net',
  'tauri://localhost',
  'https://tauri.localhost',
  // Windows WebView2 serves the packaged app from http://tauri.localhost
  // (macOS/Linux use the tauri:// scheme above instead).
  'http://tauri.localhost',
  'http://localhost:5173',
  'http://localhost:5174',
];
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : DEFAULT_ALLOWED_ORIGINS;

app.use(cors({
  origin(origin, callback) {
    // No Origin header means this isn't a browser cross-origin request
    // (server-to-server calls, health checks, curl) — nothing to gate here.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
}));
// Stripe webhooks need the raw body for signature verification, so this must
// be mounted before the JSON body parser.
app.use('/webhooks', express.raw({ type: 'application/json' }), stripeWebhookRoutes);
// Parse JSON bodies. Also accept text/plain — Opera's built-in proxy/Turbo mode
// routes HTTP traffic through compression servers which can change Content-Type
// from application/json to text/plain, leaving req.body empty and causing Zod
// validation failures.
// Default body-size limit is 100kb — too small for MissionMap layouts once a
// surface map's terrain heightmap (4,225-element array, baked in at creation
// even before any sculpting) is added on top of everything else in the
// layout; additional maps would silently fail to save past that point.
app.use(express.json({ type: ['application/json', 'text/plain'], limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Routes
app.use('/auth', authRoutes);
app.use('/orgs', orgRoutes);
app.use('/admin', adminRoutes);
app.use('/users', userRoutes);
app.use('/friends', friendRoutes);
app.use('/downloads', downloadRoutes);
app.use('/events', sseRoutes);
app.use('/diag', diagRoutes);
app.use('/game-ships', gameShipsRoutes);
app.use('/hangar', hangarRoutes);
app.use('/dm', dmRoutes);
app.use('/abuse-reports', abuseRoutes);

// Serve uploaded chat images
// Cross-Origin-Resource-Policy must be 'cross-origin' here because the Tauri
// desktop client loads images via <img> (no-cors mode) from tauri://localhost,
// which is a different origin than spectercoms.net.  Helmet's default of
// 'same-origin' silently blocks those loads even though CORS allows the fetch.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
app.use('/uploads', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(uploadsDir));
// Channels are mounted inside orgRoutes now? 
// Wait, I put `app.use('/orgs', orgRoutes);`
// And inside `org.ts` I should mount the channel routes?


// Database Pool (Managed in config/db.ts, but we keep this check or remove it)
// We'll remove the local pool config here as it's now in config/db.ts

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start Server
app.listen(port, async () => {
  console.log(`Identity Service running on port ${port}`);
  // Seed in-memory channel presence from DB so a container restart doesn't
  // wipe occupant state.  Clients on a stale resume path will re-register
  // presence once they reconnect; offline clients are preserved as-is.
  await seedPresenceFromDb();
});

import { pool } from './config/db.js';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';

// ─── Admin Seed ────────────────────────────────────────────────────────────────
// If ADMIN_SEED_USERNAME / EMAIL / PASSWORD env vars are set AND the
// platform_admins table is empty, automatically insert a root admin on startup.
// This ensures a fresh volume always gets an admin without manual intervention.
async function seedAdminIfNeeded(): Promise<void> {
  const username = process.env.ADMIN_SEED_USERNAME;
  const email    = process.env.ADMIN_SEED_EMAIL;
  const password = process.env.ADMIN_SEED_PASSWORD;

  if (!username || !email || !password) return;

  try {
    const existing = await pool.query('SELECT id FROM platform_admins LIMIT 1');
    if (existing.rows.length > 0) return; // Admin already exists, skip

    const hash   = await argon2.hash(password, { type: argon2.argon2id });
    const secret = crypto.randomBytes(20).toString('hex').toUpperCase().slice(0, 32);
    const perms  = JSON.stringify({ can_ban_global: true, super_admin: true });

    await pool.query(
      `INSERT INTO platform_admins (id, username, email, password_hash, rotp_secret, permissions)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [username, email, hash, secret, perms]
    );
    console.log(`[seed] Platform admin '${username}' created.`);
  } catch (err) {
    console.error('[seed] Failed to seed admin:', err);
  }
}

seedAdminIfNeeded();

// Graceful Shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing pool...');
  await pool.end();
  process.exit(0);
});
