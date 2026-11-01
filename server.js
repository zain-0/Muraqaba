import mongoose from 'mongoose';
import config from './config/config.js';
import connectDB from './config/db.js';
import app from './app.js';

const start = async () => {
  await connectDB();

  const server = app.listen(config.port, () => {
    console.log(`Muraqaba API listening on port ${config.port} (${config.env})`);
    console.log(`Docs: http://localhost:${config.port}/api-docs`);
  });

  // Finish in-flight requests, then close the DB connection, on SIGINT/SIGTERM (Ctrl+C, docker stop).
  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await mongoose.connection.close(false);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
