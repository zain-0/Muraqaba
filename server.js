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
app.use(cors());
app.use(express.json());
app.use(cookieParser());

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
