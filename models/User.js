import mongoose from 'mongoose';

export const ROLES = ['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'];

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    // Never returned by default. Controllers that need it must call .select('+password').
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, index: true },
    signatureImage: { type: mongoose.Schema.Types.ObjectId, ref: 'SignatureImage' },
    // A vendor outside our list, named when an accident VSR went to them (2026-11-11). Nobody can
    // sign in as one: the service creator records their steps. Never listed with our vendors.
    outside: { type: Boolean, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        ret.hasSignature = Boolean(ret.signatureImage);
        delete ret.signatureImage;
        return ret;
      },
    },
  }
);

// A drawing is never changed once saved; a new signature is a new record, so old stamps stay true.
const SignatureImageSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    image: { type: String, required: true },
  },
  { timestamps: true }
);

export const SignatureImage = mongoose.model('SignatureImage', SignatureImageSchema);

const User = mongoose.model('User', UserSchema);
export default User;
