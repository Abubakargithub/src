import mongoose from 'mongoose';

export const FEE_PAYERS = ['Creator pays', 'Shared'];

// Any legacy or unknown value (e.g. the old 'Member pays' default) is stored as 'Shared',
// which is how the server already treated it when computing fees.
const toFeePayer = value => {
  const v = String(value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ');
  return v.startsWith('creator') || v === 'owner' || v.startsWith('owner pays') ? 'Creator pays' : 'Shared';
};

const groupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: { type: String, default: null },
  category: { type: String, default: 'Family' },
  contribution_amount: { type: Number, default: 50000 },
  frequency: { type: String, default: 'Weekly' },
  member_count: { type: Number, default: 6 },
  start_date: { type: String, default: null },
  contribution_day: { type: String, default: 'Saturday' },
  fee_payer: { type: String, enum: FEE_PAYERS, default: 'Shared', set: toFeePayer },
  service_fee_percent: { type: Number, default: 5 },
  status: { type: String, default: 'active' },
  current_series: { type: Number, default: 1 },
  owner_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  created_at: { type: Date, default: Date.now },
});

export const Group = mongoose.model('Group', groupSchema);