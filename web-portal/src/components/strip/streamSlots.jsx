import { MonitorPlay } from 'lucide-react';
import { SLOT_PRIORITY } from './barSlots';
import { SlotChip } from './StripBarSlots';

/**
 * SV: the bar's "watch" slot — someone else in my voice channel is sharing
 * and the strip's viewer isn't open: a red ▶ chip opens it watching them. With
 * several sharers it carries their count and opens the Channels cabinet (its
 * joined view has a Watch button per sharer). Nothing while the viewer is
 * open (the viewer is right there) or outside voice.
 * engine        useEngine() result
 * viewerOpen    the strip's viewer is showing
 * onWatch(callsign), onOpenChannels()
 */
export function streamWatchSlots({ engine, viewerOpen, onWatch, onOpenChannels }) {
  const v = engine?.state?.voice;
  if (!engine?.connected || !v?.channelId || viewerOpen) return [];
  const me = engine.state.user?.callsign ?? null;
  const others = v.sharers.filter((c) => c && c !== me);
  if (!others.length) return [];
  const many = others.length > 1;
  const label = many
    ? `${others.length} people are sharing. Choose a stream to watch`
    : `${others[0]} is sharing. Watch here`;
  // Icon-only (the name is in the tooltip): the slot row is ~150px at the
  // bar's normal width and this must not push the Overlay chip out.
  return [{
    id: 'watch',
    priority: SLOT_PRIORITY.watch,
    minWidth: 26,
    node: (
      <SlotChip iconOnly tone="live" icon={<MonitorPlay size={13} />} label={label}
        onClick={() => (many ? onOpenChannels() : onWatch(others[0]))}>
        {many && (
          <span aria-hidden="true" className="pointer-events-none absolute -top-1 -right-1 min-w-[14px] h-[14px] px-0.5 rounded-pill bg-red-500 text-[9px] leading-[14px] text-white text-center font-semibold border border-[#0b1d2e]">
            {others.length}
          </span>
        )}
      </SlotChip>
    ),
  }];
}
