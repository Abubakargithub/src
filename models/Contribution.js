import mongoose from 'mongoose';

const contributionSchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true, index: true },
  member_name: { type: String, required: true },
  series_number: { type: Number, required: true },
  amount: { type: Number, required: true },
  status: { type: String, default: 'completed' },
  payment_method: { type: String, default: 'card' },
  due_date: { type: String, default: null },
  paid_at: { type: Date, default: null },
  reference: { type: String, default: null },
  paystack_reference: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
});

// Idempotency lives in the database, not just in application code:
// 1. A Paystack reference can be recorded once. (Partial index so rows with reference = null are fine.)
contributionSchema.index({ reference: 1 }, { unique: true, partialFilterExpression: { reference: { $type: 'string' } } });
// 2. A member can have only ONE completed contribution per series.
contributionSchema.index(
  { group_id: 1, member_id: 1, series_number: 1 },
  { unique: true, partialFilterExpression: { status: 'completed' } },
);
// Speeds up getSeriesState (runs on every payout check).
contributionSchema.index({ group_id: 1, series_number: 1, status: 1 });

export const Contribution = mongoose.model('Contribution', contributionSchema);