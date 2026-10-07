import mongoose from 'mongoose';

const activitySchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', default: null },
  // Free-form on purpose. Server-written types include: contribution, cashout, member,
  // missed_payment, refund, member_exit, member_replacement, unallocated_funds (owner-only).
  // Clients may only create 'member' and 'note' (see routes/activity.js).
  type: { type: String, required: true },
  title: { type: String, required: true },
  amount: { type: Number, default: null },
  status: { type: String, default: 'completed' },
  payment_method: { type: String, default: null },
  reference: { type: String, default: null },
  meta: { type: String, default: null },
  created_at: { type: Date, default: Date.now },
});

activitySchema.index({ created_at: -1 });
// The group feed: newest first.
activitySchema.index({ group_id: 1, created_at: -1 });
// "Have we already flagged this payment?" lookup.
activitySchema.index({ reference: 1, type: 1 });

export const Activity = mongoose.model('Activity', activitySchema);