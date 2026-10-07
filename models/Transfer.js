import mongoose from 'mongoose';

const transferSchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  recipient_code: { type: String, default: null },
  amount: { type: Number, required: true },
  gross_amount: { type: Number, default: null },
  service_fee: { type: Number, default: 0 },
  currency: { type: String, default: 'NGN' },
  reason: { type: String, default: 'Dashe cash-out payout' },
  reference: { type: String, required: true, unique: true },
  paystack_transfer_code: { type: String, default: null },
  // Left free-form on purpose: Paystack may return statuses beyond pending/otp/success
  // (the code treats every status except failed/reversed as "payout made or in flight").
  status: { type: String, default: 'pending' },
  series_number: { type: Number, default: null },
  paystack_response: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
});

// Hard stop against paying the same series out twice: at most ONE successful
// transfer per group + series. (A reversed payout is stored as 'failed', which frees the slot.)
transferSchema.index(
  { group_id: 1, series_number: 1 },
  { unique: true, partialFilterExpression: { status: 'success' } },
);
// GET /transfers (a user's own history).
transferSchema.index({ user_id: 1, created_at: -1 });
// The reconciliation job looks for old unfinished transfers.
transferSchema.index({ status: 1, created_at: 1 });

export const Transfer = mongoose.model('Transfer', transferSchema);