import mongoose from 'mongoose';

const memberSchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  name: { type: String, required: true },
  phone: { type: String, default: null },
  initials: { type: String, default: '' },
  position: { type: Number, required: true },
  role: { type: String, default: 'member' },
  paid_count: { type: Number, default: 0 },
  status: { type: String, default: 'pending' },
  guarantor_name: { type: String, default: null },
  guarantor_phone: { type: String, default: null },
  guarantor_address: { type: String, default: null },
  guarantor_relationship: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
});

export const Member = mongoose.model('Member', memberSchema);
