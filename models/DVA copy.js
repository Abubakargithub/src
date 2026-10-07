import mongoose from 'mongoose';

const dvaSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null, index: true },
  member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', default: null },
  account_name: { type: String, required: true },
  account_number: { type: String, required: true },
  bank: { type: String, default: 'Wema Bank' },
  bank_code: { type: String, default: '044' },
  currency: { type: String, default: 'NGN' },
  paystack_customer_code: { type: String, default: null },
  paystack_dva_reference: { type: String, default: null },
  status: { type: String, default: 'active' },
  series_number: { type: Number, default: null },
  amount_expected: { type: Number, default: 0 },
  amount_received: { type: Number, default: 0 },
  expires_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now },
});

export const DVA = mongoose.model('DVA', dvaSchema);
