const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres:postgres@127.0.0.1:5432/uptimebuddy' });

async function updatePw() {
  try {
    await pool.query("UPDATE users SET password_hash = '$2b$10$Lxi4Q7.9fWpH6iqhFWZoDOuft3ZCrdpdaDUXOlvS44Fhp24KNdTmPq' WHERE id = 1");
    console.log("Database seeded successfully.");
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}
updatePw();
