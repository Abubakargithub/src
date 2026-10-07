import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { authRouter } from './routes/auth.js';
import { groupsRouter } from './routes/groups.js';
import { contributionsRouter } from './routes/contributions.js';
import { activityRouter } from './routes/activity.js';
import { bankAccountsRouter } from './routes/bankAccounts.js';
//import { paystackRouter, runAutomaticPayouts, reconcilePendingTransfers } from './routes/paystack.js';
import { notificationsRouter } from './routes/notifications.js';
import { messagesRouter } from './routes/messages.js';
import { assertJwtSecret } from './middleware/auth.js';
import { Schedule } from './models/Schedule.js';
import { Member } from './models/Member.js';
import { Notification } from './models/Notification.js';
import { lagosToday } from './utils/date.js';
import { paystackRouter, runAutomaticPayouts, reconcilePendingTransfers, reconcileDvaCredits } from './routes/paystack.js';
assertJwtSecret();

const app = express();

if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// Plain "a=b" query strings only: blocks ?group_id[$ne]=x style operator injection.
app.set('query parser', 'simple');

if (process.env.NODE_ENV === 'production' && !process.env.CLIENT_ORIGIN) {
  console.warn('CLIENT_ORIGIN is not set: CORS is open to every origin. Set it in production.');
}

app.use(helmet());
app.use(cors({ origin: process.env.CLIENT_ORIGIN || '*' }));
// rawBody is required to verify Paystack webhook signatures byte-for-byte.
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

// ---- Rate limiting ----
const isWebhook = req => req.path.startsWith('/payments/webhook') || req.path.startsWith('/payments/dva/webhook');
const limiter = (windowMs, max, message) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  message: { error: message },
});

app.use('/api', rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
  skip: isWebhook, // never throttle Paystack
  message: { error: 'Too many requests. Please slow down.' },
}));
app.use('/api/auth/login', limiter(15 * 60 * 1000, 10, 'Too many login attempts. Try again later.'));
app.use('/api/auth/signup', limiter(60 * 60 * 1000, 10, 'Too many sign-up attempts. Try again later.'));
app.use('/api/payments/identity', limiter(60 * 60 * 1000, 10, 'Too many verification attempts. Try again later.'));
app.use('/api/messages', (req, res, next) =>
  req.method === 'POST' ? limiter(60 * 1000, 30, 'You are sending messages too quickly.')(req, res, next) : next());

app.use('/api/auth', authRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/contributions', contributionsRouter);
app.use('/api/activity', activityRouter);
app.use('/api/bank-accounts', bankAccountsRouter);
app.use('/api/payments', paystackRouter);
app.use('/api/notifications', notificationsRouter);
app.use('/api/messages', messagesRouter);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
schedule('DVA reconciliation', reconcileDvaCredits, 5 * 60 * 1000);
async function sendPushNotification(user, title, body) {
  if (!user?.push_token) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: user.push_token, title, body, sound: 'default', channelId: 'default' }),
    });
  } catch (err) {
    console.error('Push notification failed:', err.message);
  }
}

async function createPaymentReminders() {
  const today = lagosToday();
  const schedules = await Schedule.find({ status: 'pending', due_date: { $lte: today } }).populate('group_id');
  for (const schedule of schedules) {
    if (!schedule.group_id) continue; // group was deleted
    const member = await Member.findOne({ group_id: schedule.group_id._id, position: schedule.series_number, status: 'active' }).populate('user_id');
    const user = member?.user_id;
    if (!user || !user.notification_enabled) continue;
    const late = schedule.due_date < today;
    const type = late ? 'payment_late' : 'payment_due';
    const reminderKey = `${type}:${schedule._id}:${today}`;
    const alreadySent = await Notification.exists({ user_id: user._id, 'meta.reminder_key': reminderKey });
    if (alreadySent) continue;
    const title = late ? 'Contribution payment is late' : 'Contribution payment due today';
    const body = late
      ? `Your Series ${schedule.series_number} contribution is overdue. Pay now to keep your position on track.`
      : `Your Series ${schedule.series_number} contribution is due today. You can pay now or pay an upcoming series in advance.`;
    await Notification.create({
      user_id: user._id,
      group_id: schedule.group_id._id,
      member_id: member._id,
      type,
      title,
      body,
      meta: { group_id: String(schedule.group_id._id), series_number: schedule.series_number, reminder_key: reminderKey },
    });
    await sendPushNotification(user, title, body);
  }
}

// Runs a job on an interval without ever overlapping itself.
function schedule(name, fn, everyMs) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await fn(); } catch (err) { console.error(`${name} job failed:`, err.message); }
    finally { running = false; }
  };
  tick();
  setInterval(tick, everyMs);
}

if (!MONGODB_URI) {
  console.error('MONGODB_URI is required. Copy .env.example to .env and fill in your connection string.');
  process.exit(1);
}

mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    schedule('Reminder', createPaymentReminders, 60 * 60 * 1000);
    schedule('Automatic payout', runAutomaticPayouts, 15 * 60 * 1000);
    schedule('Transfer reconciliation', reconcilePendingTransfers, 10 * 60 * 1000);
    app.listen(PORT, () => console.log(`Dashe server running on port ${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });