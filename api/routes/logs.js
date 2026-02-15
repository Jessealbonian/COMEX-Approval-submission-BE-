const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { authGuard, requireRole } = require("../middleware/auth");

// Get staff/admin logs
router.get("/staff", authGuard, requireRole("staff"), async (req, res) => {
  try {
    console.log("Fetching staff logs...");
    const query = `
      SELECT 
        l.log_id,
        l.user_id,
        l.user_name,
        l.user_role,
        l.action,
        l.details,
        l.timestamp
      FROM activity_logs l
      WHERE l.user_role IN ('staff', 'volunteer')
      ORDER BY l.timestamp DESC
      LIMIT 100
    `;

    console.log("Executing query:", query);
    const logs = await new Promise((resolve, reject) => {
      db.query(query, (err, rows) => {
        if (err) {
          console.error("Database error:", err);
          return reject(err);
        }
        console.log("Query successful, rows returned:", rows.length);
        resolve(rows);
      });
    });

    console.log("Sending response with", logs.length, "logs");
    res.json(logs);
  } catch (error) {
    console.error("Error fetching staff logs:", error);
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

// Get student logs
router.get("/student", authGuard, requireRole("staff"), async (req, res) => {
  try {
    console.log("Fetching student logs...");
    const query = `
      SELECT 
        l.log_id,
        l.user_id,
        l.user_name,
        l.user_role,
        l.action,
        l.details,
        l.timestamp
      FROM activity_logs l
      WHERE l.user_role = 'student'
      ORDER BY l.timestamp DESC
      LIMIT 100
    `;

    console.log("Executing query:", query);
    const logs = await new Promise((resolve, reject) => {
      db.query(query, (err, rows) => {
        if (err) {
          console.error("Database error:", err);
          return reject(err);
        }
        console.log("Query successful, rows returned:", rows.length);
        resolve(rows);
      });
    });

    console.log("Sending response with", logs.length, "logs");
    res.json(logs);
  } catch (error) {
    console.error("Error fetching student logs:", error);
    res
      .status(500)
      .json({ error: "Internal server error", details: error.message });
  }
});

// Create a new log entry (utility function for other route files)
const createLog = async (userId, userName, userRole, action, details) => {
  try {
    const query = `
      INSERT INTO activity_logs (user_id, user_name, user_role, action, details)
      VALUES (?, ?, ?, ?, ?)
    `;

    await new Promise((resolve, reject) => {
      db.query(query, [userId, userName, userRole, action, details], (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  } catch (error) {
    console.error("Error creating log entry:", error);
  }
};

// Export the createLog function for use in other route files
module.exports = { router, createLog };
