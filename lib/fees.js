// Server-side fee logic (source of truth). Client mirror: lib/fees.ts.
//
//   Shared       -> contributors pay nothing extra; the fee is deducted from each cash-out.
//   Creator pays -> recipient gets the full pool; the creator adds the fee on top of
//                   their own contribution each series.
// Any other (legacy) value is treated as 'Shared'.

export const FEE_PAYER_OPTIONS = ['Creator pays', 'Shared'];
export const DEFAULT_FEE_PERCENT = 5;

export const feePayer = group => {
  const raw = String(group?.fee_payer ?? group?.feePayer ?? '')
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  return raw.startsWith('creator') || raw === 'owner' || raw.startsWith('owner pays') ? 'Creator pays' : 'Shared';
};

export const feePercent = group => {
  const raw = group?.service_fee_percent ?? group?.fee_percent ?? group?.feePercent;
  if (raw === null || raw === undefined || raw === '') return DEFAULT_FEE_PERCENT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_FEE_PERCENT;
};

export const isCreatorPays = group => feePayer(group) === 'Creator pays';

export const grossPool = group => group.contribution_amount * group.member_count;

export const payoutFee = (group, gross = grossPool(group)) =>
  Math.round((gross * feePercent(group)) / 100);

export const payoutNet = (group, gross = grossPool(group)) =>
  isCreatorPays(group) ? gross : gross - payoutFee(group, gross);

export const contributionFee = (group, member) =>
  isCreatorPays(group) && member?.role === 'creator' ? payoutFee(group) : 0;