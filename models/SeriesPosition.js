import mongoose from 'mongoose';

const positionSchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', required: true },
  position: { type: Number, required: true },
  reason: { type: String, default: 'Initial assignment' },
  created_at: { type: Date, default: Date.now },
});

export const SeriesPosition = mongoose.model('SeriesPosition', positionSchema);
