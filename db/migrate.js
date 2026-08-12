// db/migrate.js — Migration runner for Purple Premium Bread
// Runs all files in db/migrations/ in filename order, tracking applied
// migrations in the schema_migrations table. Safe to run repeatedly.
//
// Usage:  node db/migrate.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function migrate() {
    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    // Ensure the tracking table exists (also created by 001, but needed before first run)
    await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY,
            filename VARCHAR UNIQUE NOT NULL,
            applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const applied = await db.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.rows.map(r => r.filename));

    for (const file of files) {
        if (appliedSet.has(file)) {
            console.log(`⏭  Skipping ${file} (already applied)`);
            continue;
        }
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        console.log(`▶  Applying ${file} ...`);
        try {
            await db.query(sql);
            console.log(`✅ Applied ${file}`);
        } catch (err) {
            console.error(`❌ Failed on ${file}:`, err.message);
            process.exitCode = 1;
            break;
        }
    }

    await db.pool.end();
    console.log('Migration run complete.');
}

migrate();
