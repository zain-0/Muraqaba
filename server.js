import express from 'express';
import dotenv from 'dotenv';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import swaggerDocument from './swagger/swagger.json' assert { type: 'json' };

// Import routes
import authRoutes from './routes/authRoutes.js';
import repairRequestRoutes from './routes/repairRequestRoutes.js';
import ticketRoutes from './routes/ticketRoutes.js';
import userRoutes from './routes/userRoutes.js';
import vendorRoutes from './routes/vendorRoutes.js';
import busRoutes from './routes/busRoutes.js';
// Import the database connection
import connectDB from './config/db.js';

// Environment Variables Setup
dotenv.config();

// Create the Express app
const app = express();

// Middleware setup
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        res.header('Access-Control-Allow-Origin', 'http://localhost:3000');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.header('Access-Control-Allow-Credentials', 'true');
        return res.status(200).end();
    }
    next();
});
// Configure CORS to allow requests from http://localhost:3000
app.use(cors({
    origin: 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// Middleware to handle OPTIONS method for all routes

// Connect to MongoDB
connectDB(); // Connects to the MongoDB database

// Swagger setup
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Define Routes
app.use('/api/auth', authRoutes);
app.use('/api/repair-requests', repairRequestRoutes); // Protected route
app.use('/api/tickets', ticketRoutes);               // Protected route
app.use('/api/users', userRoutes);                   // Protected route
app.use('/api/vendors', vendorRoutes);       
app.use('/api/bus', busRoutes)        // Protected route

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
