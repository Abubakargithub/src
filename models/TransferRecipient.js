import mongoose from 'mongoose';

const recipientSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, default: 'nuban' },
  name: { type: String, required: true },
  account_number: { type: String, required: true },
  bank_code: { type: String, required: true },
  bank_name: { type: String, default: '' },
  currency: { type: String, default: 'NGN' },
  paystack_recipient_code: { type: String, default: null },
  is_verified: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

// The same bank account can be saved once per user (a double-tap can no longer create
// two recipients, which would also restart the new-account cooldown clock unpredictably).
recipientSchema.index({ user_id: 1, account_number: 1, bank_code: 1 }, { unique: true });

export const TransferRecipient = mongoose.model('TransferRecipient', recipientSchema);