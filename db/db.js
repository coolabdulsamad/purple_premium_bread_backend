const { Pool } = require('pg');

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
  ssl: {
    rejectUnauthorized: true,
  },
});

// Test connection on startup
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('Error connecting to the database', err.stack);
  } else {
    console.log('✅ Database connection successful!');
  }
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  // ✅ Add this helper for transactions (used in /confirm route)
  getClient: async () => {
    try {
      const client = await pool.connect();
      return client;
    } catch (error) {
      console.error('❌ Error getting DB client:', error);
      throw error;
    }
  },
};
