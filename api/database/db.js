const mysql = require("mysql2");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER || process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || process.env.DB_DATABASE,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  ...(process.env.DB_SSL === "true"
    ? { ssl: { rejectUnauthorized: true } }
    : {}),
};

const connection = mysql.createConnection(dbConfig);

connection.connect((error) => {
  if (error) {
    console.error("Error connecting to the database:", error);
    return;
  }
  console.log("Successfully connected to the database.");
});

module.exports = connection;
