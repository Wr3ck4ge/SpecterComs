// Card convenience-fee gross-up. The org pool must net exactly the intended
// amount after the processor takes its cut, so the charge is solved from
// charge * (1 - PCT) - FIXED >= net rather than a flat percentage markup.

export const CARD_FEE_PERCENT = 2.9;
export const CARD_FEE_FIXED_CENTS = 30;
export const MIN_CONTRIBUTION_CENTS = 100;

export function cardGrossUp(netCents: number): { chargeCents: number; feeCents: number } {
  if (!Number.isInteger(netCents) || netCents < MIN_CONTRIBUTION_CENTS) {
    throw new Error(`netCents must be a whole number >= ${MIN_CONTRIBUTION_CENTS}`);
  }
  const chargeCents = Math.ceil((netCents + CARD_FEE_FIXED_CENTS) / (1 - CARD_FEE_PERCENT / 100));
  return { chargeCents, feeCents: chargeCents - netCents };
}
