// Load environment variables from .env file
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const connection = require("./database/db"); // Import database connection

// Import routes
const authRoutes = require("./routes/auth");
const apiRoutes = require("./routes/api");
const menuRoutes = require("./routes/menu");
const usersRoutes = require("./routes/users");
const orderRoutes = require("./routes/orders");
const volunteerRoutes = require("./routes/volunteers");
const { router: logsRoutes } = require("./routes/logs");
const viewsRoutes = require("./routes/views");

// Create Express app
const app = express();

// NOTE: Apply CORS before Helmet to avoid interfering with CORS headers

// Configure CORS with support for multiple origins and wildcards (comma-separated)
const corsEnv = process.env.CORS_ORIGIN || process.env.CORS_ORIGINS;
const allowedOriginEntries = (corsEnv || "http://localhost:4200")
  .split(",")
  .map((s) => s.trim())
  // Strip surrounding quotes if present and remove any trailing slash
  .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s))
  .map((s) => (s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1) : s))
  .map((s) => s.replace(/\/$/, ""))
  .filter(Boolean);

// Convert entries like "https://*.vercel.app" into regexes; treat "*" as allow-all
const allowAll = allowedOriginEntries.includes("*");
const allowedOriginRegexes = allowedOriginEntries
  .filter((entry) => entry !== "*")
  .map((entry) => {
    // Escape regex special chars but leave '*' to be expanded into '.*'
    const escaped = entry.replace(/[-\/\\^$+?.()|[\]{}]/g, "\\$&");
    const pattern = "^" + escaped.replace(/\*/g, ".*") + "$";
    return new RegExp(pattern);
  });

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // non-browser or same-origin
    if (allowAll) return callback(null, true);

    let host = origin;
    try {
      host = new URL(origin).hostname;
    } catch {}

    const originAllowed =
      allowedOriginRegexes.some((re) => re.test(origin)) ||
      allowedOriginRegexes.some((re) => re.test(host));

    // Also allow common Vercel preview/prod domains if wildcard for vercel is present
    const hasVercelWildcard = allowedOriginEntries.some((e) =>
      e.includes("*.vercel.app")
    );
    const isVercelHost =
      typeof host === "string" && host.endsWith(".vercel.app");

    if (originAllowed || (hasVercelWildcard && isVercelHost)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  // 204 is preferred for preflight responses
  optionsSuccessStatus: 204,
  // Don’t fix allowed headers; let CORS reflect the browser’s Access-Control-Request-Headers
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};

app.use(cors(corsOptions));
// Ensure preflight requests are handled (use RegExp in Express 5)
app.options(/.*/, cors(corsOptions));

// Set security HTTP headers (after CORS)
app.use(helmet());

// Middleware for parsing JSON bodies with increased limit for image data
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Request logger middleware
app.use((req, res, next) => {
  console.log(
    `${new Date().toISOString()} - ${req.method} ${
      req.path
    } - Content-Length: ${req.headers["content-length"] || "unknown"}`
  );
  next();
});

// Ensure default categories exist
const DEFAULT_CATEGORIES = ["Rice Meals", "Drinks", "Sandwiches", "Snacks"];
function ensureDefaultCategories() {
  DEFAULT_CATEGORIES.forEach((name) => {
    connection.query(
      "INSERT IGNORE INTO categories (category_name) VALUES (?)",
      [name],
      (err) => {
        if (err) {
          console.error("Error seeding category", name, err);
        }
      }
    );
  });
}

// Middleware to check database connection
app.use((req, res, next) => {
  if (connection.state === "disconnected") {
    return res.status(500).json({ message: "Database connection lost." });
  }
  next();
});

// Routes
app.use("/auth", authRoutes);
app.use("/api", apiRoutes);
app.use("/menu", menuRoutes);
app.use("/users", usersRoutes);
app.use("/orders", orderRoutes);
app.use("/volunteers", volunteerRoutes);
app.use("/logs", logsRoutes);
app.use("/views", viewsRoutes);

// Root endpoint
app.get("/", (req, res) => {
  res.json({ message: "Welcome to the Canteen API!" });
});

// Handle not found errors
app.use((req, res, next) => {
  res.status(404).json({ message: "Not Found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Global error handler caught:", err);

  if (err.type === "entity.too.large") {
    return res.status(413).json({
      message: "Request entity too large",
      error:
        "The data you are trying to send is too large. Please reduce the image size.",
    });
  }

  res.status(500).json({
    message: "Something went wrong!",
    error:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Internal server error",
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  ensureDefaultCategories();
  // Ensure Volunteers table exists
  const createVolunteersTable = `
    CREATE TABLE IF NOT EXISTS Volunteers (
      user_id INT PRIMARY KEY,
      is_available TINYINT(1) NOT NULL DEFAULT 0,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES Users(user_id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;
  connection.query(createVolunteersTable, (err) => {
    if (err) {
      console.error("Failed to ensure Volunteers table:", err);
    } else {
      // Ensure schedule columns exist (migration for existing databases)
      connection.query(
        `SELECT COLUMN_NAME 
         FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() 
         AND TABLE_NAME = 'volunteers' 
         AND COLUMN_NAME = 'availability_start_time'`,
        (err, rows) => {
          if (err) {
            console.error("Failed to check for schedule columns:", err);
            return;
          }
          if (rows.length === 0) {
            // Add schedule columns if they don't exist
            connection.query(
              `ALTER TABLE volunteers 
               ADD COLUMN availability_start_time TIME NULL DEFAULT NULL AFTER is_available,
               ADD COLUMN availability_end_time TIME NULL DEFAULT NULL AFTER availability_start_time`,
              (err) => {
                if (err) {
                  console.error("Failed to add schedule columns:", err);
                } else {
                  console.log("Successfully added schedule columns to volunteers table");
                }
              }
            );
          }
        }
      );
    }
  });
});
