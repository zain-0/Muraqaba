import mongoose from 'mongoose';
import config from './config.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Connect to MongoDB with exponential backoff and jitter. A database that is still
 * starting (common with Docker) should not take the API down, so we retry with growing
 * delays and only give up after maxAttempts.
 */
const connectDB = async ({ maxAttempts = 8, baseDelayMs = 500, maxDelayMs = 15000 } = {}) => {
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true); // defends against query operator injection

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await mongoose.connect(config.mongoURI, { serverSelectionTimeoutMS: 5000 });
      console.log(`MongoDB connected (${mongoose.connection.host}/${mongoose.connection.name})`);
      return mongoose.connection;
    } catch (error) {
      if (attempt === maxAttempts) {
        console.error(`MongoDB connection failed after ${maxAttempts} attempts: ${error.message}`);
        throw error;
      }
      const base = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delay = Math.round(base * (0.75 + Math.random() * 0.5));
      console.warn(`MongoDB connection attempt ${attempt}/${maxAttempts} failed (${error.message}). Retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  return null;
};

mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));

export default connectDB;
