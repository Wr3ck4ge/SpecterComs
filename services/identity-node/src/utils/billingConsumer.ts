import { connectNats } from '../config/nats.js';
import { pool } from '../config/db.js';
import { StringCodec } from 'nats';
import { evictUserPresence } from '../controllers/channelController.js';

interface SessionEndEvent {
  org_id: string;
  user_id: string;
  channel_id: string;
  duration_secs: number;
  bytes_out: number;
  // True when this session was killed because the same user reconnected and
  // a newer session already replaced it (see media-rust main.rs). In that
  // case presence must NOT be evicted — the new session already owns it.
  superseded?: boolean;
}

/**
 * Subscribes to specter.usage.session_end events emitted by the Rust SFU and
 * accumulates them into org_billing rows. Runs silently if NATS is unavailable.
 *
 * NOTE: BILLING_ENFORCE is intentionally NOT checked here — we always want
 * accurate metering data even while enforcement is disabled during testing.
 */
export async function startBillingConsumer(): Promise<void> {
  const nc = await connectNats();
  if (!nc) {
    console.warn('[billing] NATS unavailable — usage events will not be metered');
    return;
  }

  const sc = StringCodec();
  const sub = nc.subscribe('specter.usage.session_end');
  console.log('[billing] Subscribed to specter.usage.session_end');

  (async () => {
    for await (const msg of sub) {
      try {
        const event: SessionEndEvent = JSON.parse(sc.decode(msg.data));

        if (!event.org_id || typeof event.duration_secs !== 'number') {
          continue;
        }

        // Evict the user from channel presence — handles the case where the
        // client died without calling leaveChannelPresence (crash, force-close, etc.)
        // Skip eviction when this session was superseded by a rejoin: the newer
        // session already re-added presence, so evicting here would wipe out a
        // still-connected user (see media-rust's was_killed/session_nonces guard).
        if (event.user_id && event.channel_id && !event.superseded) {
          evictUserPresence(event.user_id, event.org_id, event.channel_id).catch(err =>
            console.error('[billing] presence eviction error:', err)
          );
        }

        // Upsert: create a billing row if it doesn't exist yet, otherwise accumulate.
        // Member-hours is intentionally not tracked (product decision — see billingController.ts).
        await pool.query(
          `INSERT INTO org_billing (org_id, cycle_bytes_out)
           VALUES ($1, $2)
           ON CONFLICT (org_id) DO UPDATE SET
             cycle_bytes_out = org_billing.cycle_bytes_out + EXCLUDED.cycle_bytes_out,
             updated_at      = NOW()`,
          [event.org_id, event.bytes_out ?? 0]
        );

        // Daily usage bucket for the usage-metrics page. The SFU only reports one
        // cumulative total per session (no periodic ticks), so there is no way to
        // split a session's bytes across the days it spanned — the whole session's
        // bytes_out is attributed to the day the session_end event arrived.
        await pool.query(
          `INSERT INTO org_usage_daily (org_id, day, bytes_out)
           VALUES ($1, CURRENT_DATE, $2)
           ON CONFLICT (org_id, day) DO UPDATE SET
             bytes_out  = org_usage_daily.bytes_out + EXCLUDED.bytes_out,
             updated_at = NOW()`,
          [event.org_id, event.bytes_out ?? 0]
        );
      } catch (err) {
        console.error('[billing] Consumer error processing session_end:', err);
      }
    }
  })();
}
