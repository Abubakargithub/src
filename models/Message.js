import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  sender_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  text: { type: String, required: true, trim: true, maxlength: 2000 },
  read_at: { type: Date, default: null },
  created_at: { type: Date, default: Date.now, index: true },
});

messageSchema.index({ group_id: 1, sender_id: 1, recipient_id: 1, created_at: 1 });

export const Message = mongoose.model('Message', messageSchema);