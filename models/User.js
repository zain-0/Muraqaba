import mongoose from 'mongoose';

export const ROLES = ['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'];

const UserSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    // Never returned by default. Controllers that need it must call .select('+password').
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true, index: true },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.password;
        delete ret.__v;
        return ret;
      },
    },
  }
);

const User = mongoose.model('User', UserSchema);
export default User;
