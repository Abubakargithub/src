import mongoose from 'mongoose';

// Generic in-app notification. `user_id` is who should see it.
// `type` drives icon/routing on the client: 'invite' | 'invite_accepted' |
// 'contribution' | 'cashout' | 'group' | 'payout_blocked' etc.
const notificationSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', default: null },
    member_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Member', default: null },
    type: { type: String, required: true },
    title: { type: String, required: true },
    body: { type: String, default: null },
    read: { type: Boolean, default: false },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: {
      transform: (_doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

// Notification list, unread badge, and the "already sent this reminder?" check.
notificationSchema.index({ user_id: 1, created_at: -1 });
notificationSchema.index({ user_id: 1, read: 1 });
notificationSchema.index({ user_id: 1, 'meta.reminder_key': 1 });

export const Notification = mongoose.model('Notification', notificationSchema);