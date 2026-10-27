import { connect, NatsConnection, StringCodec, JetStreamManager } from 'nats';
import dotenv from 'dotenv';
import { pool } from './db.js';
dotenv.config();

let natsConnection: NatsConnection | null = null;
const sc = StringCodec();

const ensureMsgStream = async (nc: NatsConnection) => {
  const jsm: JetStreamManager = await nc.jetstreamManager();
  const streamName = 'SPECTER_MSGS';
  try {
    await jsm.streams.info(streamName);
  } catch {
    await jsm.streams.add({
      name: streamName,
      subjects: ['specter.msg.channel.*', 'specter.msg.dm.*'],
      retention: 'limits' as any,
      max_age: 86400 * 1e9, // nanoseconds
      storage: 'memory' as any,
      max_msg_size: 32768,
      discard: 'old' as any,
    });
  }
};

// The media relay's channel-hierarchy map is purely in-memory, populated only
// by live specter.event.tree.> publishes at launch time — so a relay restart
// mid-event starts empty and silently loses ducking-cascade/leader
// dual-subscribe state for anything not re-published since. It requests a
// backfill of this shape once at its own startup; this is the responder.
const startEventTreeResponder = (nc: NatsConnection) => {
    (async () => {
        const sub = nc.subscribe('specter.event.tree.request');
        for await (const msg of sub) {
            try {
                const result = await pool.query(
                    `SELECT c.id, c.parent_channel_id AS parent_id,
                            eg.leader_user_id
                     FROM channels c
                     JOIN events e ON c.event_id = e.id
                     LEFT JOIN event_groups eg ON eg.channel_id = c.id
                     WHERE e.launched = true`
                );
                const channels = result.rows.map((r: any) => ({
                    id: r.id,
                    parent_id: r.parent_id || null,
                    // tier isn't read by the relay's cascade logic (parent_id-driven
                    // graph walk) — 0 is a harmless placeholder kept for payload-shape
                    // parity with the live per-launch publish.
                    tier: 0,
                    leader_user_id: r.leader_user_id || null,
                }));
                msg.respond(sc.encode(JSON.stringify({ type: 'event_tree', channels })));
            } catch (err) {
                console.error('Event tree backfill responder error:', err);
                try { msg.respond(sc.encode(JSON.stringify({ type: 'event_tree', channels: [] }))); } catch {}
            }
        }
    })();
};

export const connectNats = async () => {
    if (natsConnection) return natsConnection;

    const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
    // Phase B: optional NATS auth token — see the matching comment in
    // services/media-rust/src/main.rs for why this is optional rather than
    // fail-closed (flows in ahead of the server actually requiring auth).
    const natsAuthToken = process.env.NATS_AUTH_TOKEN || undefined;
    try {
        natsConnection = await connect({ servers: natsUrl, token: natsAuthToken });
        console.log(`Connected to NATS at ${natsUrl}`);
        await ensureMsgStream(natsConnection);
        startEventTreeResponder(natsConnection);
        return natsConnection;
    } catch (err) {
        console.error(`Error connecting to NATS:`, err);
        return null; // Return null instead of throwing to allow running without nats in local dev if needed
    }
};

export const publishEvent = async (subject: string, data: any) => {
    let nc = natsConnection;
    if (!nc) {
        nc = await connectNats();
    }
    
    if (nc) {
        try {
            nc.publish(subject, sc.encode(JSON.stringify(data)));
        } catch (err) {
             console.error(`Failed to publish event to ${subject}:`, err);
        }
    }
};
