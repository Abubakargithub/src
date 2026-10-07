import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { User } from '../models/User.js';
import { generateToken, authMiddleware } from '../middleware/auth.js';
import { normalizePhone } from '../utils/phone.js';

export const authRouter = Router();

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const MAX_DEVICES = 5;
const MAX_AVATAR_CHARS = 400_000; // roughly 300 KB of image
const AVATAR_RE = /^(data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+|https:\/\/\S+)$/;

const GENERIC = 'Something went wrong. Please try again.';
const fail = (res, err) => {
  console.error('[auth]', err);
  return res.status(500).json({ error: GENERIC });
};

const cleanEmail = v => (typeof v === 'string' ? v.trim().toLowerCase() : '');
const isEmail = v => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const cleanPhone = v => {
  const p = normalizePhone(v);
  return p && /^\+\d{10,15}$/.test(p) ? p : null;
};
const hashDeviceToken = t => crypto.createHash('sha256').update(t).digest('hex');

// Fields safe to return to the client.
function serializeUser(user) {
  return {
    id: user._id,
    full_name: user.full_name,
    email: user.email,
    phone: user.phone,
    phone_verified: user.phone_verified,
    avatar_color: user.avatar_color,
    avatar_url: user.avatar_url,
    verified: user.verified,
    biometric_enabled: user.biometric_enabled,
    notification_enabled: user.notification_enabled,
    language: user.language,
    identity_type: user.identity_type,
    identity_status: user.identity_status,
    identity_verified_at: user.identity_verified_at,
  };
}

authRouter.post('/signup', async (req, res) => {
  try {
    const { full_name, password, phone } = req.body || {};
    const email = cleanEmail(req.body?.email);
    const name = typeof full_name === 'string' ? full_name.trim() : '';

    if (!name || !email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Full name, email, and password are required' });
    }
    if (name.length > 100) return res.status(400).json({ error: 'Full name is too long' });
    if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address' });
    if (password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: 'Password must be 8 to 128 characters' });
    }

    let normalizedPhone = null;
    if (phone) {
      normalizedPhone = cleanPhone(phone);
      if (!normalizedPhone) return res.status(400).json({ error: 'Enter a valid phone number' });
      // Uniqueness only. Ownership is proven separately by OTP (phone_verified).
      const phoneTaken = await User.exists({ phone: normalizedPhone });
      if (phoneTaken) return res.status(409).json({ error: 'An account with this phone number already exists' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const password_hash = await bcrypt.hash(password, 10);
    const user = await User.create({ full_name: name, email, password_hash, phone: normalizedPhone });
    const token = generateToken(user);
    res.status(201).json({ token, user: serializeUser(user) });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: 'An account with these details already exists' });
    fail(res, err);
  }
});

authRouter.post('/login', async (req, res) => {
  try {
    const email = cleanEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    const user = await User.findOne({ email });
    if (!user || user.is_suspended === true) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.locked_until && user.locked_until > new Date()) {
      return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const updated = await User.findByIdAndUpdate(user._id, { $inc: { failed_logins: 1 } }, { new: true }).select('failed_logins');
      if (updated && updated.failed_logins >= MAX_FAILED_LOGINS) {
        await User.updateOne(
          { _id: user._id },
          { $set: { locked_until: new Date(Date.now() + LOCK_MINUTES * 60 * 1000), failed_logins: 0 } },
        );
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.failed_logins || user.locked_until) {
      await User.updateOne({ _id: user._id }, { $set: { failed_logins: 0, locked_until: null } });
    }

    const token = generateToken(user);
    res.json({ token, user: serializeUser(user) });
  } catch (err) {
    fail(res, err);
  }
});

// ---------------------------------------------------------------------------
// Biometric / device login WITHOUT storing the password on the phone.
//
// When the user turns on biometric login, the server hands the device a random
// secret (returned once, stored only as a SHA-256 hash here). The app keeps it in the
// secure keystore and, after a successful fingerprint/Face ID scan, exchanges it for a
// normal session token. It can be revoked per device or all at once, and it cannot be
// used to recover the password.
// ---------------------------------------------------------------------------
authRouter.post('/device-token', authMiddleware, async (req, res) => {
  try {
    const deviceToken = crypto.randomBytes(32).toString('base64url');
    await User.updateOne({ _id: req.userId }, {
      $push: {
        device_tokens: {
          $each: [{ hash: hashDeviceToken(deviceToken), created_at: new Date(), last_used_at: null }],
          $slice: -MAX_DEVICES, // keep only the newest few devices
        },
      },
    });
    res.status(201).json({ device_token: deviceToken });
  } catch (err) {
    fail(res, err);
  }
});

authRouter.post('/device-login', async (req, res) => {
  try {
    const t = req.body?.device_token;
    const expired = { error: 'Biometric sign-in has expired. Please log in with your password.' };
    if (typeof t !== 'string' || t.length < 20 || t.length > 100) return res.status(401).json(expired);

    const hash = hashDeviceToken(t);
    const user = await User.findOne({ 'device_tokens.hash': hash });
    if (!user || user.is_suspended === true) return res.status(401).json(expired);

    await User.updateOne(
      { _id: user._id, 'device_tokens.hash': hash },
      { $set: { 'device_tokens.$.last_used_at': new Date() } },
    );
    res.json({ token: generateToken(user), user: serializeUser(user) });
  } catch (err) {
    fail(res, err);
  }
});

authRouter.post('/device-token/revoke', authMiddleware, async (req, res) => {
  try {
    const t = req.body?.device_token;
    if (typeof t === 'string' && t.length >= 20 && t.length <= 100) {
      await User.updateOne({ _id: req.userId }, { $pull: { device_tokens: { hash: hashDeviceToken(t) } } });
    }
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

// Invalidates every token issued so far (all devices, including this one) and revokes
// every biometric device. The client should clear its stored token and go to login.
authRouter.post('/logout-all', authMiddleware, async (req, res) => {
  try {
    await User.updateOne({ _id: req.userId }, { $inc: { token_version: 1 }, $set: { device_tokens: [] } });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

authRouter.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: serializeUser(user) });
  } catch (err) {
    fail(res, err);
  }
});

// `verified`, `phone_verified` and all identity_* fields are server-controlled:
// never accepted from the client. Only fields that actually CHANGED are checked, so a
// routine save (for example a new avatar colour) never trips the name lock.
authRouter.put('/profile', authMiddleware, async (req, res) => {
  try {
    const current = await User.findById(req.userId);
    if (!current) return res.status(404).json({ error: 'User not found' });

    const body = req.body || {};
    const updates = {};

    if (body.full_name !== undefined) {
      const name = typeof body.full_name === 'string' ? body.full_name.trim() : '';
      if (!name || name.length > 100) return res.status(400).json({ error: 'Enter a valid name' });
      if (name !== current.full_name) {
        // Once identity is verified the name is locked; otherwise someone could
        // rename themselves to match a stolen bank account.
        if (current.identity_status === 'verified') {
          return res.status(403).json({ error: 'Your name cannot be changed after identity verification' });
        }
        updates.full_name = name;
      }
    }

    // An empty phone field means "no change" (the app sends it for users without a number).
    if (body.phone !== undefined && String(body.phone).trim() !== '') {
      const phone = cleanPhone(body.phone);
      if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
      if (phone !== normalizePhone(current.phone)) {
        const taken = await User.exists({ phone, _id: { $ne: req.userId } });
        if (taken) return res.status(409).json({ error: 'That phone number is already in use' });
        updates.phone = phone;
        updates.phone_verified = false; // a new number must be proven again by OTP
      }
    }

    for (const key of ['avatar_color', 'language']) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'string' || body[key].length > 50) {
          return res.status(400).json({ error: `Invalid ${key}` });
        }
        updates[key] = body[key];
      }
    }
    if (body.avatar_url !== undefined) {
      const a = body.avatar_url;
      if (a !== null) {
        if (typeof a !== 'string' || a.length > MAX_AVATAR_CHARS) {
          return res.status(400).json({ error: 'That photo is too large. Choose a smaller one.' });
        }
        if (!AVATAR_RE.test(a)) return res.status(400).json({ error: 'Unsupported photo format.' });
      }
      updates.avatar_url = a;
    }
    for (const key of ['biometric_enabled', 'notification_enabled']) {
      if (body[key] !== undefined) {
        if (typeof body[key] !== 'boolean') return res.status(400).json({ error: `Invalid ${key}` });
        updates[key] = body[key];
      }
    }

    const user = Object.keys(updates).length
      ? await User.findByIdAndUpdate(req.userId, updates, { new: true })
      : current;
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user: serializeUser(user) });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: 'That phone number is already in use' });
    fail(res, err);
  }
});

// Call on sign-out so payment/payout notifications stop reaching this device.
authRouter.delete('/push-token', authMiddleware, async (req, res) => {
  try {
    await User.updateOne({ _id: req.userId }, { $unset: { push_token: 1 } });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});

authRouter.put('/push-token', authMiddleware, async (req, res) => {
  try {
    const { push_token } = req.body || {};
    if (!push_token || typeof push_token !== 'string' || push_token.length > 300) {
      return res.status(400).json({ error: 'push_token is required' });
    }
    // A device token belongs to one account at a time, otherwise the previous
    // account's payment/payout notifications reach whoever logs in next.
    await User.updateMany({ push_token, _id: { $ne: req.userId } }, { $unset: { push_token: 1 } });
    await User.findByIdAndUpdate(req.userId, { push_token });
    res.json({ success: true });
  } catch (err) {
    fail(res, err);
  }
});