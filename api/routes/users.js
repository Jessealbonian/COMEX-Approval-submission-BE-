const express = require("express");
const bcrypt = require("bcryptjs");
const router = express.Router();
const connection = require("../database/db");
const { authGuard, requireRole } = require("../middleware/auth");

const ALLOWED_ROLES = ["student", "staff", "volunteer"];

function isValidPhone(phone) {
  if (!phone) return true;
  const digitsOnly = String(phone).replace(/\s|-/g, "");
  return /^(\+?\d{10,15}|09\d{9})$/.test(digitsOnly);
}

// GET /users - list users with optional search, role filter, and pagination
router.get("/", authGuard, requireRole("staff"), async (req, res) => {
  try {
    const { q = "", role = "", page = "1", limit = "10" } = req.query;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 100);
    const offset = (pageNum - 1) * limitNum;

    const conditions = [];
    const params = [];

    if (q) {
      conditions.push("(name LIKE ? OR email LIKE ?)");
      params.push(`%${q}%`, `%${q}%`);
    }
    if (role && ALLOWED_ROLES.includes(String(role))) {
      conditions.push("role = ?");
      params.push(role);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const countSql = `SELECT COUNT(*) as total FROM users ${whereClause}`;
    const listSql = `SELECT user_id, name, email, phone_no, department, role, status, created_at
                     FROM users ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;

    // Count
    const total = await new Promise((resolve, reject) => {
      connection.query(countSql, params, (err, rows) => {
        if (err) return reject(err);
        resolve(rows[0]?.total || 0);
      });
    });

    // List
    const data = await new Promise((resolve, reject) => {
      connection.query(listSql, [...params, limitNum, offset], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    return res.json({ data, total, page: pageNum, limit: limitNum });
  } catch (err) {
    console.error("Failed to list users", err);
    return res.status(500).json({ message: "Failed to list users" });
  }
});

// POST /users - create a new user (staff only)
router.post("/", authGuard, requireRole("staff"), async (req, res) => {
  try {
    const {
      name,
      email,
      password,
      phone_no,
      department,
      role = "student",
      status = "approved",
    } = req.body || {};

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ message: "name, email and password are required" });
    }
    if (!ALLOWED_ROLES.includes(role)) {
      return res.status(400).json({ message: "Invalid role" });
    }
    if (!isValidPhone(phone_no)) {
      return res.status(400).json({ message: "Invalid contact number format" });
    }

    // Unique email check
    const existing = await new Promise((resolve, reject) => {
      connection.query(
        "SELECT user_id FROM users WHERE email = ?",
        [email],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        }
      );
    });
    if (existing && existing.length > 0) {
      return res
        .status(409)
        .json({ message: "User with this email already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const newUser = {
      name,
      email,
      password_hash,
      phone_no,
      department,
      role,
      status,
    };

    const result = await new Promise((resolve, reject) => {
      connection.query("INSERT INTO users SET ?", newUser, (err, resu) => {
        if (err) return reject(err);
        resolve(resu);
      });
    });

    return res.status(201).json({
      message: "User created successfully",
      user_id: result.insertId,
    });
  } catch (err) {
    console.error("Failed to create user", err);
    return res.status(500).json({ message: "Failed to create user" });
  }
});

// PUT /users/:id - update user
router.put("/:id", authGuard, requireRole("staff"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, phone_no, department, role, status } =
      req.body || {};

    const updateData = {};
    if (name != null) updateData.name = name;
    if (email != null) updateData.email = email;
    if (phone_no != null) updateData.phone_no = phone_no;
    if (department != null) updateData.department = department;
    if (role != null) {
      if (!ALLOWED_ROLES.includes(role)) {
        return res.status(400).json({ message: "Invalid role" });
      }
      updateData.role = role;
    }
    if (status != null) updateData.status = status;
    if (password) {
      const salt = await bcrypt.genSalt(10);
      updateData.password_hash = await bcrypt.hash(password, salt);
    }

    if (updateData.phone_no && !isValidPhone(updateData.phone_no)) {
      return res.status(400).json({ message: "Invalid contact number format" });
    }

    // Unique email check for updates
    if (updateData.email) {
      const emailClash = await new Promise((resolve, reject) => {
        connection.query(
          "SELECT user_id FROM users WHERE email = ? AND user_id <> ?",
          [updateData.email, id],
          (err, rows) => {
            if (err) return reject(err);
            resolve(rows);
          }
        );
      });
      if (emailClash && emailClash.length > 0) {
        return res
          .status(409)
          .json({ message: "User with this email already exists" });
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ message: "No fields to update" });
    }

    await new Promise((resolve, reject) => {
      connection.query(
        "UPDATE users SET ? WHERE user_id = ?",
        [updateData, id],
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
    });

    return res.json({ message: "User updated successfully" });
  } catch (err) {
    console.error("Failed to update user", err);
    return res.status(500).json({ message: "Failed to update user" });
  }
});

// DELETE /users/:id - delete user (if not referenced by orders)
router.delete("/:id", authGuard, requireRole("staff"), async (req, res) => {
  try {
    const { id } = req.params;

    // Check references in orders table
    const [{ count: orderRefs }] = await new Promise((resolve, reject) => {
      connection.query(
        "SELECT (SELECT COUNT(*) FROM orders WHERE student_id = ?) + (SELECT COUNT(*) FROM orders WHERE volunteer_id = ?) AS count",
        [id, id],
        (err, rows) => {
          if (err) return reject(err);
          resolve(rows);
        }
      );
    });

    if (orderRefs > 0) {
      return res.status(409).json({
        message: "Cannot delete user because there are related orders",
      });
    }

    await new Promise((resolve, reject) => {
      connection.query(
        "DELETE FROM users WHERE user_id = ?",
        [id],
        (err, result) => {
          if (err) return reject(err);
          resolve(result);
        }
      );
    });

    return res.json({ message: "User deleted successfully" });
  } catch (err) {
    console.error("Failed to delete user", err);
    return res.status(500).json({ message: "Failed to delete user" });
  }
});

module.exports = router;
