// utils/schemaReady.js — cached check for whether a migration table exists.
// Lets every new module no-op gracefully until the migration has been applied.
const db = require('../db/db');

const cache = new Map(); // tableName -> boolean

async function hasTable(tableName) {
    if (cache.has(tableName)) return cache.get(tableName);
    try {
        const result = await db.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
            [tableName]
        );
        const exists = result.rows.length > 0;
        cache.set(tableName, exists);
        return exists;
    } catch (err) {
        // If we can't even check, assume missing and fail safe (allow behavior unchanged)
        return false;
    }
}

function clearSchemaCache() {
    cache.clear();
}

module.exports = { hasTable, clearSchemaCache };
