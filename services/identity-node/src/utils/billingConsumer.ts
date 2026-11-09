import { connectNats } from '../config/nats.js';
import { pool } from '../config/db.js';
import { StringCodec } from 'nats';
import { evictUserPresence } from '../controllers/channelController.js';
import { SESSION_END_SUBJECT, acceptNodeMessage, warnRejected } from './natsSubjects.js';

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
  // The publishing node (contract C2). Required on the scoped subject.
  node_id?: string;
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
  // Contract C2: scoped specter.usage.session_end.<NODE_ID> plus the legacy
  // unscoped subject mid-rollout.
  for (const subject of [SESSION_END_SUBJECT, `${SESSION_END_SUBJECT}.*`]) {
    const sub = nc.subscribe(subject);
    console.log(`[billing] Subscribed to ${subject}`);
    (async () => {
      for await (const msg of sub) {
        try {
          await handleSessionEndMessage(msg.subject, JSON.parse(sc.decode(msg.data)));
        } catch (err) {
          console.error('[billing] Consumer error processing session_end:', err);
        }
      }
    })();
  }
}

/**
 * One session_end event. A scoped event must carry `node_id` equal to its
 * subject suffix, or it is dropped (a node can only publish its own suffix, so
 * this ties the meter to the node that sent it).
 */
export async function handleSessionEndMessage(subject: string, event: SessionEndEvent): Promise<void> {
  const verdict = acceptNodeMessage(subject, SESSION_END_SUBJECT, event?.node_id);
  if (!verdict.ok) {
    warnRejected('session_end', verdict.reason);
    return;
  }
  await handleSessionEnd(event);
}

async function handleSessionEnd(event: SessionEndEvent): Promise<void> {
        if (!event.org_id || typeof event.duration_secs !== 'number') {
          return;
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
}
