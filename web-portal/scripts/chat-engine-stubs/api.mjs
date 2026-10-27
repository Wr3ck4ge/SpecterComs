// Records every request the chat engine makes.
export const calls = [];
export const channelsByOrg = new Map();

export const api = {
  requestOrgSync: async (orgId, channels) => { calls.push({ fn: 'requestOrgSync', orgId, channels }); return { data: { ok: true }, error: null }; },
  respondOrgSync: async (orgId, toUserId, channelId, bundle, count) => {
    calls.push({ fn: 'respondOrgSync', orgId, toUserId, channelId, bundle, count });
    return { data: { ok: true }, error: null };
  },
  respondChannelSync: async (orgId, channelId, toUserId, messages) => {
    calls.push({ fn: 'respondChannelSync', orgId, channelId, toUserId, messages });
    return { data: { ok: true }, error: null };
  },
  requestDmSync: async (userId, since) => { calls.push({ fn: 'requestDmSync', userId, since }); return { data: { ok: true }, error: null }; },
  respondDmSyncBundle: async (userId, bundle, count) => {
    calls.push({ fn: 'respondDmSyncBundle', userId, bundle, count });
    return { data: { ok: true }, error: null };
  },
  getChannels: async (orgId) => ({ data: { channels: (channelsByOrg.get(orgId) || []).map((id) => ({ id })) }, error: null }),
  sendMessage: async () => ({ data: { id: 'sent', timestamp: new Date().toISOString() }, error: null }),
};
