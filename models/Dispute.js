import mongoose from 'mongoose';

const disputeSchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  series_number: { type: Number, required: true },
  type: { type: String, default: 'payout_not_received' },
  note: { type: String, default: '', maxlength: 500 },
  transfer_reference: { type: String, default: null },
  transfer_status: { type: String, default: null },
  status: { type: String, enum: ['open', 'resolved', 'rejected'], default: 'open' },
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

export const Dispute = mongoose.model('Dispute', disputeSchema);