import fs from 'fs';
import { initializeApp, cert, type App } from 'firebase-admin/app';
import { getMessaging, type SendResponse } from 'firebase-admin/messaging';
import { pool } from '../config/db.js';

// Mirrors the TLS_CERT/TLS_KEY pattern already used for the certbot cert
// (docker-compose.prod.yml) rather than putting raw JSON in an env var value --
// the credential file is volume-mounted into the container and this just
// points at its in-container path. Empty/unset = push disabled entirely,
// matching how PAYMENTS_PROVIDER unset disables billing (utils/emailService.ts
// has no such gate since SMTP failure there is non-fatal to the caller, but a
// missing Firebase credential shouldn't crash the pushWatcher loop).
let app: App | null | undefined; // undefined = not yet attempted, null = attempted and unavailable

function getApp(): App | null {
  if (app !== undefined) return app;

  const credPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!credPath || !fs.existsSync(credPath)) {
    console.warn('[push] FIREBASE_SERVICE_ACCOUNT_PATH not set or file missing — push notifications disabled.');
    app = null;
    return app;
  }

  const serviceAccount = JSON.parse(fs.readFileSync(credPath, 'utf-8'));
  app = initializeApp({ credential: cert(serviceAccount) });
  return app;
}

async function sendToAllAdmins(title: string, body: string): Promise<void> {
  const firebaseApp = getApp();
  if (!firebaseApp) return;

  const tokensRes = await pool.query(`SELECT fcm_token FROM admin_push_tokens`);
  const tokens: string[] = tokensRes.rows.map((r) => r.fcm_token);
  if (tokens.length === 0) {
    console.log('[push] no registered tokens, nothing to send');
    return;
  }

  const response = await getMessaging(firebaseApp).sendEachForMulticast({
    tokens,
    notification: { title, body },
    android: { priority: 'high' },
  });
  console.log(`[push] sent to ${tokens.length} token(s): ${response.successCount} succeeded, ${response.failureCount} failed`);
  response.responses.forEach((r: SendResponse, i: number) => {
    if (!r.success) console.log(`[push] token ${i} failed: ${r.error?.code} ${r.error?.message}`);
  });

  // Prune tokens FCM reports as dead (app uninstalled, token rotated without
  // re-registering, etc.) so the recipient list doesn't silently rot.
  const deadTokens: string[] = [];
  response.responses.forEach((r: SendResponse, i: number) => {
    if (!r.success && r.error?.code === 'messaging/registration-token-not-registered') {
      deadTokens.push(tokens[i]);
    }
  });
  if (deadTokens.length > 0) {
    await pool.query(`DELETE FROM admin_push_tokens WHERE fcm_token = ANY($1)`, [deadTokens]);
  }
}

export async function sendNodeOfflineAlert(nodeId: string): Promise<void> {
  await sendToAllAdmins('SpecterComs — Node Offline', `${nodeId} has stopped heartbeating.`);
}

export async function sendNodeOverloadedAlert(nodeId: string): Promise<void> {
  await sendToAllAdmins('SpecterComs — Node Overloaded', `${nodeId} is at or over its load threshold.`);
}

export async function sendScalingWarningAlert(): Promise<void> {
  await sendToAllAdmins('SpecterComs — Capacity Warning', 'Every online node is overloaded — no headroom left in the pool.');
}
