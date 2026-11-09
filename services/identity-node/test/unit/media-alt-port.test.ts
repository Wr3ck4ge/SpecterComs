/** alt_media_url: the heartbeat's optional alt_port -> the media-ticket's alt URL (utils/mediaAltPort.ts). */
import { describe, it, expect, beforeEach } from 'vitest';
import { noteNodeAltPort, altMediaUrlFor, _resetAltPortsForTests } from '../../src/utils/mediaAltPort.js';

beforeEach(() => _resetAltPortsForTests());

describe('alternate media port', () => {
  it('absent alt_port = no alt URL (older relays, or the env unset)', () => {
    noteNodeAltPort('https://spectercoms.net', undefined, 0);
    expect(altMediaUrlFor('https://spectercoms.net', 0)).toBeNull();
  });
  it('same host, alternate port; trailing slash tolerated', () => {
    noteNodeAltPort('https://spectercoms.net/', 3478, 0);
    expect(altMediaUrlFor('https://spectercoms.net', 1000)).toBe('https://spectercoms.net:3478');
    noteNodeAltPort('https://spectercoms.net:444', 3479, 0);
    expect(altMediaUrlFor('https://spectercoms.net:444', 0)).toBe('https://spectercoms.net:3479');
  });
  it('goes stale without heartbeats, and a heartbeat without it clears it', () => {
    noteNodeAltPort('https://a.example', 3478, 0);
    expect(altMediaUrlFor('https://a.example', 31_000)).toBeNull();
    noteNodeAltPort('https://a.example', 3478, 40_000);
    noteNodeAltPort('https://a.example', null, 41_000);
    expect(altMediaUrlFor('https://a.example', 41_000)).toBeNull();
  });
  it('rejects junk ports', () => {
    for (const p of [0, -1, 70000, 3.5, '3478']) {
      noteNodeAltPort('https://b.example', p, 0);
      expect(altMediaUrlFor('https://b.example', 0)).toBeNull();
    }
  });
});
