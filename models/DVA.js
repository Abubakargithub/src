import mongoose from 'mongoose';

const dvaSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null, index: true },
  member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', default: null },
  account_name: { type: String, required: true },
  account_number: { type: String, required: true, index: true },
  bank: { type: String, default: 'Wema Bank' },
  bank_code: { type: String, default: '044' },
  currency: { type: String, default: 'NGN' },
  paystack_customer_code: { type: String, default: null },
  paystack_dva_reference: { type: String, default: null },
  status: { type: String, default: 'active' },
  series_number: { type: Number, default: null },
  // amount_expected = contribution_amount + service_fee (fee is 0 unless the
  // group is 'Creator pays' and this DVA belongs to the creator).
  amount_expected: { type: Number, default: 0 },
  contribution_amount: { type: Number, default: 0 },
  service_fee: { type: Number, default: 0 },
  amount_received: { type: Number, default: 0 },
  // Paystack webhook references already applied to this DVA (idempotency).
  processed_references: { type: [String], default: [] },
  expires_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
});

export const DVA = mongoose.model('DVA', dvaSchema);