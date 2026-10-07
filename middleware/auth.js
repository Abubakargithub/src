import jwt from 'jsonwebtoken';
import { User } from '../models/User.js';

// Call once at startup (index.js). Refuses to boot with a weak/missing secret.
export function assertJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    console.error('JWT_SECRET is required and must be at least 32 characters.');
    process.exit(1);
  }
}

export async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = header.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  if (typeof decoded?.userId !== 'string' || !/^[a-f\d]{24}$/i.test(decoded.userId)) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  try {
    // Kill switches: a suspended/deleted account, or a token issued before the
    // last "log out everywhere" (token_version bump), is rejected immediately.
    const user = await User.findById(decoded.userId).select('email is_suspended token_version').lean();
    if (!user || user.is_suspended === true) {
      return res.status(401).json({ error: 'Account unavailable' });
    }
    if ((decoded.tv ?? 0) !== (user.token_version ?? 0)) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    req.userId = decoded.userId;
    req.userEmail = user.email;
    next();
  } catch (err) {
    console.error('[auth] user lookup failed:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}

export function generateToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), email: user.email, tv: user.token_version ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: '7d', algorithm: 'HS256' }
  );
}