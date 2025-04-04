import dotenv from 'dotenv';

// Load environment variables from .env file
dotenv.config();

const config = {
  // MongoDB URI from environment variable
  mongoURI: process.env.MONGO_URI,

  // JWT Secret for Authentication (if using JWT)
  jwtSecret: process.env.JWT_SECRET,

  // Server Port (defaults to 5000 if not provided in .env)
  port: process.env.PORT || 5000,

  // API Version (can be used for versioning your API endpoints)
  apiVersion: process.env.API_VERSION || 'v1',

  // Mail Service Configurations (if applicable, e.g., for sending emails)
  mailService: {
    host: process.env.MAIL_HOST,
    port: process.env.MAIL_PORT,
    user: process.env.MAIL_USER,
    password: process.env.MAIL_PASSWORD,
    from: process.env.MAIL_FROM,
  },

  // Other configurations can be added as needed
  someOtherSetting: process.env.SOME_OTHER_SETTING || 'default_value',
};

export default config;
