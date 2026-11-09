import { SLOT_PRIORITY } from './barSlots';
import { OverlayChip, SpeakerChip, StreamChip } from './StripVoiceControls';

/**
 * BAR2: the voice slots for the bar's slot row (StripBarSlots): the voice
 * status chip first (always, once the engine is connected: the channel name —
 * plus who's talking — in voice, "Not in voice" outside), plus Stream and
 * Overlay while in a voice channel. LIVE: the status took the row's lead
 * place (the live-op chip moved to the notice beside the bar) and stays in
 * the slot row in voice too, so it has the row's width instead of sharing
 * the server-name row.
 * engine         useEngine() result (state, levels, pending)
 * pickerOpen     the share picker is showing
 * transmitting   PTT held (StripApp's specter://ptt-active)
 * onOpenChannels(), onToggleOverlay(), onShareClick()
 */
export function voiceSlots({ engine, pickerOpen, transmitting = false, onOpenChannels, onToggleOverlay, onShareClick }) {
  if (!engine?.connected) return [];
  const { state } = engine;
  const inVoice = Boolean(state.voice.channelId);
  const slots = [{
    id: 'speaker',
    priority: SLOT_PRIORITY.speaker,
    // "Not in voice" is shown whole (it's short); in voice the chip widens
    // into the rest of the row for the channel name.
    minWidth: inVoice ? 96 : 92,
    grow: true,
    node: (
      <SpeakerChip voice={state.voice} me={state.user?.callsign ?? null} speaking={engine.levels?.speaking || []}
        transmitting={transmitting} onClick={onOpenChannels} />
    ),
  }];
  if (inVoice) {
    slots.push({
      id: 'stream',
      priority: SLOT_PRIORITY.stream,
      minWidth: state.voice.sharing ? 48 : 26,
      node: <StreamChip engine={engine} pickerOpen={pickerOpen} onClick={onShareClick} />,
    }, {
      id: 'overlay',
      priority: SLOT_PRIORITY.overlay,
      minWidth: 26,
      node: <OverlayChip engine={engine} onClick={onToggleOverlay} />,
    });
  }
  return slots;
}
