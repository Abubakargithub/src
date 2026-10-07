import mongoose from 'mongoose';
import { Group, FEE_PAYERS } from '../models/Group.js';

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error('No MONGODB_URI / MONGO_URI found. Check the variable name in your .env file.');
  process.exit(1);
}

await mongoose.connect(uri);

const payer = await Group.updateMany(
  { fee_payer: { $nin: FEE_PAYERS } },
  { $set: { fee_payer: 'Shared' } },
);
const percent = await Group.updateMany(
  { $or: [{ service_fee_percent: { $exists: false } }, { service_fee_percent: null }] },
  { $set: { service_fee_percent: 5 } },
);

console.log(`fee_payer updated on ${payer.modifiedCount} group(s); service_fee_percent set on ${percent.modifiedCount} group(s).`);
await mongoose.disconnect();
