import { AlertTriangle } from 'lucide-react';
import { SLOT_PRIORITY } from './barSlots';
import { SlotChip } from './StripBarSlots';

/**
 * NET: the bar's "Voice can't connect" chip, shown while CommLink reports a
 * classified connect problem (state.voice.connectIssue). Opens Settings on the
 * Repair panel. Ranks right after the speaker chip, so it stays visible.
 */
export function repairSlot(issue, onOpen) {
  const label = `${issue.message} Run Repair`;
  return {
    id: 'voice-repair',
    priority: SLOT_PRIORITY.speaker + 5,
    minWidth: 116,
    node: (
      <SlotChip tone="warn" onClick={onOpen} label={label} title={label} icon={<AlertTriangle size={12} />}>
        Can&apos;t connect: Repair
      </SlotChip>
    ),
  };
}
