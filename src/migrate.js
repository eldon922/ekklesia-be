const pool = require("./db");

const initDatabase = async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Create events table — only name is required, all else optional
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        date DATE,
        time TIME,
        location VARCHAR(255),
        password_hash VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add password_hash column for existing installs upgrading
    await client.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);`,
    );

    // Add is_finished column for existing installs
    await client.query(
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS is_finished BOOLEAN DEFAULT FALSE;`,
    );

    // Make date nullable for existing installs (safe no-op if already nullable)
    try {
      await client.query(`ALTER TABLE events ALTER COLUMN date DROP NOT NULL;`);
    } catch (_) {}

    // Create attendees table
    await client.query(`
      CREATE TABLE IF NOT EXISTS attendees (
        id SERIAL PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        phone_number VARCHAR(50),
        email VARCHAR(255),
        checked_in BOOLEAN DEFAULT FALSE,
        checked_in_at TIMESTAMP,
        source VARCHAR(10) DEFAULT 'manual',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add source column for existing installs
    await client.query(
      `ALTER TABLE attendees ADD COLUMN IF NOT EXISTS source VARCHAR(10) DEFAULT 'manual';`,
    );

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attendees_event_id ON attendees(event_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attendees_name ON attendees(LOWER(name));`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_attendees_phone ON attendees(phone_number);`,
    );

    await client.query("COMMIT");
    console.log("Database initialized successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error initializing database:", err);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = initDatabase;
