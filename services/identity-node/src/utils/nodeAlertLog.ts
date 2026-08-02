import { pool } from '../config/db.js';

export type NodeAlertEventType = 'offline' | 'overloaded' | 'scaling_warning';

// Recorded independent of push delivery -- a device with no registered token,
// or one that missed/dismissed the notification, can still pull this history.
export async function logNodeAlertEvent(
  eventType: NodeAlertEventType,
  nodeId: string | null,
  message: string
): Promise<void> {
  await pool.query(
    `INSERT INTO node_alert_events (event_type, node_id, message) VALUES ($1, $2, $3)`,
    [eventType, nodeId, message]
  );
}
