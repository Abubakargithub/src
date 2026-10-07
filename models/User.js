import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  full_name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password_hash: { type: String, required: true },

  phone: { type: String, default: null },
  phone_verified: { type: Boolean, default: false }, // set only after an OTP check, never from the client

  avatar_color: { type: String, default: '#1463FF' },
  avatar_url: { type: String, default: null },
  verified: { type: Boolean, default: false }, // cosmetic only. Never use it to gate money movement.
  biometric_enabled: { type: Boolean, default: false },
  notification_enabled: { type: Boolean, default: true },
  push_token: { type: String, default: null },
  language: { type: String, default: 'English' },

  // KYC. Only the KYC route may write these.
  identity_type: { type: String, enum: ['bvn', 'nin', null], default: null },
  identity_status: { type: String, enum: ['unverified', 'pending', 'verified', 'failed'], default: 'unverified' },
  identity_reference: { type: String, default: null },
  identity_verified_at: { type: Date, default: null },
  identity_name: { type: String, default: null },              // name returned by the provider; compare bank name to THIS
  identity_hash: { type: String, default: null, select: false }, // HMAC-SHA256(BVN/NIN, server secret). Never store the raw number.
  identity_pending_hash: { type: String, default: null },
  // Session control (used by middleware/auth.js)
  token_version: { type: Number, default: 0 },
  is_suspended: { type: Boolean, default: false },
  failed_logins: { type: Number, default: 0 },
  locked_until: { type: Date, default: null },

  created_at: { type: Date, default: Date.now },
});

// One account per phone number. Partial index so many users can still have phone = null.
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });
// One identity (BVN/NIN) per account.
userSchema.index({ identity_hash: 1 }, { unique: true, partialFilterExpression: { identity_hash: { $type: 'string' } } });

export const User = mongoose.model('User', userSchema);