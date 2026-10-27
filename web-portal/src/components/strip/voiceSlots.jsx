import { SLOT_PRIORITY } from './barSlots';
import { OverlayChip, SpeakerChip, StreamChip } from './StripVoiceControls';

/**
 * BAR2: the voice slots for the bar's slot row (StripBarSlots): the speaker
 * chip (always, once the engine is connected — "Not in voice", lowest
 * priority, outside a channel), plus Stream and Overlay while in a voice
 * channel.
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
    // Outside voice the chip only says "Not in voice": the least important
    // slot, shown whole or not at all.
    priority: inVoice ? SLOT_PRIORITY.speaker : SLOT_PRIORITY.notInVoice,
    minWidth: inVoice ? 56 : 92,
    grow: inVoice,
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
