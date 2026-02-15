const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const connection = require("../database/db");
const { authGuard, requireRole } = require("../middleware/auth");
require("dotenv").config();

// POST /auth/register
router.post("/register", async (req, res) => {
  const { name, email, password, phone_no } = req.body;

  if (!name || !email || !password) {
    return res
      .status(400)
      .json({ message: "Please provide name, email, and password." });
  }

  try {
    // Check if user already exists
    connection.query(
      "SELECT email FROM users WHERE email = ?",
      [email],
      async (error, results) => {
        if (error) {
          console.error("Error checking for existing user:", error);
          return res.status(500).json({ message: "Internal server error" });
        }

        if (results.length > 0) {
          return res
            .status(409)
            .json({ message: "User with this email already exists." });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);

        const newUser = {
          name,
          email,
          password_hash,
          phone_no,
          role: "student", // Automatically assign role as student
          status: "pending", // Default status
        };

        connection.query(
          "INSERT INTO users SET ?",
          newUser,
          (error, results) => {
            if (error) {
              console.error("Error creating user:", error);
              return res.status(500).json({ message: "Error creating user." });
            }
            res.status(201).json({ message: "User created successfully." });
          }
        );
      }
    );
  } catch (error) {
    console.error("Error during registration:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// POST /auth/login/student
router.post("/login/student", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ message: "Please provide email and password." });
  }

  connection.query(
    "SELECT * FROM users WHERE email = ?",
    [email],
    async (error, results) => {
      if (error) {
        console.error("Error fetching user:", error);
        return res.status(500).json({ message: "Internal server error" });
      }

      if (results.length === 0) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const user = results[0];

      // Allow students and volunteers to login via this route
      if (user.role !== "student" && user.role !== "volunteer") {
        return res
          .status(403)
          .json({ message: "Access forbidden. Students/Volunteers only." });
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);

      if (!isMatch) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      // User is authenticated, create a JWT
      const payload = {
        id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
      };

      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });
      // Explicitly label the token type for frontend storage selection
      res.json({ token, user: payload, tokenType: "studentToken" });
    }
  );
});

// GET /auth/profile - Get user profile information (student/volunteer only)
router.get(
  "/profile",
  authGuard,
  requireRole("student", "volunteer"),
  async (req, res) => {
    try {
      connection.query(
        "SELECT user_id, name, email, phone_no, department, role, status FROM users WHERE user_id = ?",
        [req.user.id],
        (error, results) => {
          if (error) {
            console.error("Error fetching user profile:", error);
            return res.status(500).json({ message: "Internal server error" });
          }

          if (results.length === 0) {
            return res.status(404).json({ message: "User not found" });
          }

          const userProfile = results[0];
          return res.json({ profile: userProfile });
        }
      );
    } catch (error) {
      console.error("Error fetching profile:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

// PUT /auth/profile - Update user profile information (student/volunteer only)
router.put(
  "/profile",
  authGuard,
  requireRole("student", "volunteer"),
  async (req, res) => {
    try {
      const { phone_no } = req.body;
      const updateData = {};

      if (phone_no) updateData.phone_no = phone_no;

      if (Object.keys(updateData).length === 0) {
        return res
          .status(400)
          .json({ message: "No fields to update provided." });
      }

      connection.query(
        "UPDATE users SET ? WHERE user_id = ?",
        [updateData, req.user.id],
        (error) => {
          if (error) {
            console.error("Error updating user profile:", error);
            return res.status(500).json({ message: "Internal server error" });
          }
          return res.json({ message: "Profile updated successfully" });
        }
      );
    } catch (error) {
      console.error("Error updating profile:", error);
      return res.status(500).json({ message: "Internal server error" });
    }
  }
);

// POST /auth/login/staff
router.post("/login/staff", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res
      .status(400)
      .json({ message: "Please provide email and password." });
  }

  connection.query(
    "SELECT * FROM users WHERE email = ?",
    [email],
    async (error, results) => {
      if (error) {
        console.error("Error fetching user:", error);
        return res.status(500).json({ message: "Internal server error" });
      }

      if (results.length === 0) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const user = results[0];

      if (user.role !== "staff") {
        return res
          .status(403)
          .json({ message: "Access forbidden. Only staff can log in here." });
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);

      if (!isMatch) {
        return res.status(401).json({ message: "Invalid credentials." });
      }

      const payload = {
        id: user.user_id,
        name: user.name,
        email: user.email,
        role: user.role,
      };

      const token = jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: "1h",
      });
      // Explicitly label the token type for frontend storage selection
      res.json({ token, user: payload, tokenType: "staffToken" });
    }
  );
});

module.exports = router;
