// In-memory stand-in for src/messageStore.js with the same merge rules.
import { mergeChannelRow, mergeDmRow } from '../../src/engine/chatSyncCore.js';

export const rows = new Map(); // id → row
export const dmRows = new Map(); // id → DM row

const byConv = (convId) => [...dmRows.values()]
  .filter((r) => r.conversation_id === convId)
  .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

export async function saveDmMessage(msg) {
  const row = mergeDmRow(dmRows.get(msg.id), msg);
  if (row) dmRows.set(row.id, row);
  return row;
}
export async function saveDmMessages(convId, msgs) {
  const written = [];
  for (const m of msgs || []) {
    const row = mergeDmRow(dmRows.get(m.id), { ...m, conversation_id: convId });
    if (row) { dmRows.set(row.id, row); written.push(row); }
  }
  return written;
}
export async function getDmMessages(convId, limit = 100) { return byConv(convId).slice(-limit); }
export async function getDmMessagesSince(convId, since, limit = 200) {
  return byConv(convId).filter((r) => !since || r.timestamp > since).slice(0, limit);
}

const byChannel = (channelId) => [...rows.values()]
  .filter((r) => r.channel_id === channelId)
  .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

export function setMessageStoreUser() {}

export async function saveChannelMessage(msg) {
  const row = mergeChannelRow(rows.get(msg.id), msg);
  if (row) rows.set(row.id, row);
  return row;
}

export async function saveChannelMessages(channelId, msgs) {
  const written = [];
  for (const m of msgs || []) {
    const row = mergeChannelRow(rows.get(m.id), { ...m, channel_id: channelId });
    if (row) { rows.set(row.id, row); written.push(row); }
  }
  return written;
}

export async function getChannelMessages(channelId, limit = 100) {
  return byChannel(channelId).slice(-limit);
}

export async function getChannelMessagesSince(channelId, since, limit = 200) {
  return byChannel(channelId).filter((r) => !since || r.timestamp > since).slice(0, limit);
}
