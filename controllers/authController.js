import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { asyncHandler, AppError } from '../middleware/errorMiddleware.js';

// Register user
export const registerUser = asyncHandler(async (req, res) => {
    const { name, email, password, role } = req.body;
    
    console.log('Registration request:', { name, email, role });

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
        throw new AppError('User already exists with this email', 400);
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create a new user
    const newUser = new User({
        name,
        email,
        password: hashedPassword,
        role,
    });

    // Save the user to the database
    await newUser.save();

    // Generate a JWT token
    const token = jwt.sign(
        { id: newUser._id, role: newUser.role }, 
        process.env.JWT_SECRET, 
        { expiresIn: '24h' }
    );

    // Send response with the token
    res.status(201).json({ 
        success: true,
        message: 'User registered successfully', 
        token,
        user: {
            id: newUser._id,
            name: newUser.name,
            email: newUser.email,
            role: newUser.role
        }
    });
});

// Login user
export const loginUser = asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    
    console.log('Login request for email:', email);

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
        console.log('User not found for email:', email);
        throw new AppError('Invalid credentials', 401);
    }

    // Check if password matches
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
        console.log('Password mismatch for user:', email);
        throw new AppError('Invalid credentials', 401);
    }

    // Generate JWT token
    const token = jwt.sign(
        { id: user._id, role: user.role }, 
        process.env.JWT_SECRET, 
        { expiresIn: '24h' }
    );

    console.log('Login successful for user:', email);
    
    res.json({ 
        success: true,
        token,
        user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
        }
    });
});
