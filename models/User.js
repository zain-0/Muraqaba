import mongoose from 'mongoose';

// Define the User Schema
const UserSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
        },
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
        },
        password: {
            type: String,
            required: true,
        },
        role: {
            type: String,
            enum: ['vendor', 'serviceCreator', 'supervisor', 'purchaseManager'],
            required: true,
        },
    },
    { timestamps: true }
);

// Create the User model from the schema
const User = mongoose.model('User', UserSchema);

export default User;
