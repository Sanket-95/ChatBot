const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

async function getMainCategories() {
  const [rows] = await pool.execute(
    "SELECT * FROM category WHERE parent_id = 0"
  );
  return rows;
}

module.exports = { getMainCategories };
