const express = require("express");
const router = express.Router();
const db = require("../database/db");

// Ensure PageViews table exists
const ensurePageViewsTable = () => {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS PageViews (
      id INT PRIMARY KEY DEFAULT 1,
      view_count INT NOT NULL DEFAULT 0,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  db.query(createTableQuery, (err) => {
    if (err) {
      console.error("Error creating PageViews table:", err);
    } else {
      // Initialize with a single row if table is empty
      db.query("SELECT COUNT(*) as count FROM PageViews", (err, results) => {
        if (!err && results[0].count === 0) {
          db.query(
            "INSERT INTO PageViews (id, view_count) VALUES (1, 0)",
            (err) => {
              if (err) {
                console.error("Error initializing PageViews:", err);
              }
            }
          );
        }
      });
    }
  });
};

// Initialize table on module load
ensurePageViewsTable();

// POST /views - Record a page view
router.post("/", (req, res) => {
  // Use INSERT ... ON DUPLICATE KEY UPDATE to handle both insert and update
  // This ensures it works even if the row doesn't exist yet
  const upsertQuery = `
    INSERT INTO PageViews (id, view_count) 
    VALUES (1, 1)
    ON DUPLICATE KEY UPDATE view_count = view_count + 1
  `;

  db.query(upsertQuery, (err, results) => {
    if (err) {
      console.error("Error recording page view:", err);
      return res.status(500).json({
        success: false,
        message: "Failed to record page view",
        error: err.message,
      });
    }

    // Get the updated count
    db.query(
      "SELECT view_count FROM PageViews WHERE id = 1",
      (err, countResults) => {
        if (err) {
          console.error("Error fetching view count:", err);
          return res.status(500).json({
            success: false,
            message: "Failed to fetch view count",
            error: err.message,
          });
        }

        res.json({
          success: true,
          viewCount: countResults[0]?.view_count || 0,
        });
      }
    );
  });
});

// GET /views - Get total page view count
router.get("/", (req, res) => {
  db.query(
    "SELECT view_count FROM PageViews WHERE id = 1",
    (err, results) => {
      if (err) {
        console.error("Error fetching view count:", err);
        return res.status(500).json({
          success: false,
          message: "Failed to fetch view count",
          error: err.message,
        });
      }

      // If no row exists, initialize it and return 0
      if (!results || results.length === 0) {
        db.query(
          "INSERT INTO PageViews (id, view_count) VALUES (1, 0)",
          (initErr) => {
            if (initErr) {
              console.error("Error initializing PageViews:", initErr);
            }
            return res.json({
              success: true,
              viewCount: 0,
            });
          }
        );
        return;
      }

      const viewCount = results[0]?.view_count || 0;
      res.json({
        success: true,
        viewCount: viewCount,
      });
    }
  );
});

module.exports = router;

