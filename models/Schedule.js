import mongoose from 'mongoose';

const scheduleSchema = new mongoose.Schema({
  group_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Group', required: true, index: true },
  series_number: { type: Number, required: true },
  due_date: { type: String, default: null },
  status: { type: String, default: 'pending' },
  created_at: { type: Date, default: Date.now },
});

// Deliberately NOT unique: the member-exit flow renumbers series_number in bulk
// ($inc: -1), and a unique index would collide part-way through that update.
scheduleSchema.index({ group_id: 1, series_number: 1 });
// Payment reminder job: pending schedules that are due.
scheduleSchema.index({ status: 1, due_date: 1 });

export const Schedule = mongoose.model('Schedule', scheduleSchema);