import mongoose from 'mongoose';

const bankAccountSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  bank_name: { type: String, required: true },
  account_name: { type: String, required: true },
  account_number: { type: String, required: true },
  bank_code: { type: String, default: null },
  is_default: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

export const BankAccount = mongoose.model('BankAccount', bankAccountSchema);
