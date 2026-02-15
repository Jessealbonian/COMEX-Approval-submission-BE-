const express = require("express");
const router = express.Router();
const db = require("../database/db");
const { authGuard, requireRole } = require("../middleware/auth");
const { createLog } = require("./logs");
const {
  ensureInventoryLogTable,
  recordInventoryLog,
} = require("../utils/inventoryLogs");

// Get all products
router.get("/products", async (req, res) => {
  try {
    const query = `
      SELECT p.*, c.category_name, sc.subcategory_name 
      FROM products p 
      LEFT JOIN categories c ON p.category_id = c.category_id 
      LEFT JOIN subcategories sc ON p.subcategory_id = sc.subcategory_id
      WHERE p.is_deleted = FALSE 
      ORDER BY p.created_at DESC
    `;

    db.query(query, (error, results) => {
      if (error) {
        console.error("Error fetching products:", error);
        return res.status(500).json({ error: "Failed to fetch products" });
      }

      // Transform results to match the frontend Product interface
      const products = results.map((product) => ({
        id: product.product_id,
        name: product.product_name,
        price: parseFloat(product.price),
        image: product.image_path || "https://via.placeholder.com/100",
        category: product.category_name || "Uncategorized",
        subcategory: product.subcategory_name || null,
        stock: product.stock,
        is_visible: product.is_visible !== undefined ? product.is_visible !== 0 : true,
      }));

      res.json(products);
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Add new product (staff only)
router.post("/products", authGuard, requireRole("staff"), async (req, res) => {
  try {
    const { name, price, image, category, stock, subcategory } = req.body;

    if (!name || !category) {
      return res.status(400).json({ error: "Name and category are required" });
    }

    // Check image size (limit to 10MB for base64)
    if (image && image.length > 10 * 1024 * 1024) {
      return res.status(400).json({
        error: "Image file is too large. Please use a smaller image.",
      });
    }

    // First, get or create the category
    let categoryId;
    db.query(
      "SELECT category_id FROM categories WHERE category_name = ?",
      [category],
      (error, results) => {
        if (error) {
          console.error("Error checking category:", error);
          return res.status(500).json({ error: "Failed to check category" });
        }

        if (results.length > 0) {
          categoryId = results[0].category_id;
          ensureSubcategoryAndInsert();
        } else {
          // Create new category
          db.query(
            "INSERT INTO categories (category_name) VALUES (?)",
            [category],
            (error, result) => {
              if (error) {
                console.error("Error creating category:", error);
                return res
                  .status(500)
                  .json({ error: "Failed to create category" });
              }
              categoryId = result.insertId;
              ensureSubcategoryAndInsert();
            }
          );
        }
      }
    );

    function ensureSubcategoryAndInsert() {
      if (!subcategory) {
        return insertProduct(null);
      }

      // Ensure subcategory exists for this category
      db.query(
        "SELECT subcategory_id FROM subcategories WHERE subcategory_name = ? AND category_id = ?",
        [subcategory, categoryId],
        (error, results) => {
          if (error) {
            console.error("Error checking subcategory:", error);
            // If subcategory table is missing, fallback to insert without subcategory
            return insertProduct(null);
          }

          if (results.length > 0) {
            return insertProduct(results[0].subcategory_id);
          }

          // Create subcategory
          db.query(
            "INSERT INTO subcategories (subcategory_name, category_id) VALUES (?, ?)",
            [subcategory, categoryId],
            (error, result) => {
              if (error) {
                console.error("Error creating subcategory:", error);
                return insertProduct(null);
              }
              return insertProduct(result.insertId);
            }
          );
        }
      );
    }

    function insertProduct(subcategoryId) {
      // Prefer inserting subcategory_id and is_visible if columns exist, otherwise fallback
      const withSubAndVisQuery =
        "INSERT INTO products (product_name, price, stock, category_id, subcategory_id, image_path, is_visible) VALUES (?, ?, ?, ?, ?, ?, ?)";
      const withSubAndVisValues = [
        name,
        price,
        stock,
        categoryId,
        subcategoryId,
        image,
        1, // Default to visible
      ];
      const withSubQuery =
        "INSERT INTO products (product_name, price, stock, category_id, subcategory_id, image_path) VALUES (?, ?, ?, ?, ?, ?)";
      const withSubValues = [
        name,
        price,
        stock,
        categoryId,
        subcategoryId,
        image,
      ];
      const withoutSubQuery =
        "INSERT INTO products (product_name, price, stock, category_id, image_path) VALUES (?, ?, ?, ?, ?)";
      const withoutSubValues = [name, price, stock, categoryId, image];

      db.query(withSubAndVisQuery, withSubAndVisValues, (error, result) => {
        if (error) {
          // If is_visible column does not exist, try with subcategory only
          if (error.code === "ER_BAD_FIELD_ERROR") {
            return db.query(withSubQuery, withSubValues, (err2, res2) => {
              if (err2 && err2.code === "ER_BAD_FIELD_ERROR") {
                // If subcategory column also doesn't exist, use legacy insert
                return db.query(withoutSubQuery, withoutSubValues, (err3, res3) =>
                  handleInsertResponse(err3, res3)
                );
              }
              return handleInsertResponse(err2, res2);
            });
          }
          return handleInsertResponse(error, result);
        }
        return handleInsertResponse(null, result);
      });

      function handleInsertResponse(error, result) {
        if (error) {
          console.error("Error inserting product:", error);
          if (error.code === "ER_DATA_TOO_LONG") {
            return res.status(400).json({
              error:
                "Image data is too large. Please use a smaller image or compress it further.",
            });
          }
          return res
            .status(500)
            .json({ error: "Failed to insert product: " + error.message });
        }

        const newProduct = {
          id: result.insertId,
          name,
          price: parseFloat(price),
          image: image || "https://via.placeholder.com/100",
          category,
          subcategory: subcategory || null,
          stock: parseInt(stock),
          is_visible: true,
        };

        createLog(
          req.user.id,
          req.user.name,
          req.user.role,
          "PRODUCT_CREATED",
          `Product "${name}" created with price ₱${price}, stock: ${stock}, category: ${category}${
            subcategory ? " (" + subcategory + ")" : ""
          }`
        );

        recordInventoryLog({
          productId: newProduct.id,
          productName: newProduct.name,
          actionType: "restocked",
          quantityChange: parseInt(stock, 10) || 0,
          finalStock: parseInt(stock, 10) || 0,
          userId: req.user?.id || null,
          userName: req.user?.name || null,
        });

        res.status(201).json(newProduct);
      }
    }
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Update product (staff only)
router.put(
  "/products/:id",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { name, price, image, category, stock, subcategory } = req.body;

      if (!name || !category) {
        return res
          .status(400)
          .json({ error: "Name and category are required" });
      }

      let previousStock = 0;
      let previousProductName = name;

      try {
        const existingRows = await new Promise((resolve, reject) => {
          db.query(
            "SELECT product_name, stock FROM products WHERE product_id = ?",
            [id],
            (error, results) => {
              if (error) return reject(error);
              resolve(results);
            }
          );
        });

        if (!existingRows || existingRows.length === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        previousStock = parseInt(existingRows[0].stock, 10) || 0;
        previousProductName = existingRows[0].product_name;
      } catch (error) {
        console.error("Error fetching product before update:", error);
        return res
          .status(500)
          .json({ error: "Failed to update product" });
      }

      // Check image size (limit to 10MB for base64)
      if (image && image.length > 10 * 1024 * 1024) {
        return res.status(400).json({
          error: "Image file is too large. Please use a smaller image.",
        });
      }

      // First, get or create the category
      let categoryId;
      db.query(
        "SELECT category_id FROM categories WHERE category_name = ?",
        [category],
        (error, results) => {
          if (error) {
            console.error("Error checking category:", error);
            return res.status(500).json({ error: "Failed to check category" });
          }

          if (results.length > 0) {
            categoryId = results[0].category_id;
            ensureSubcategoryAndUpdate();
          } else {
            // Create new category
            db.query(
              "INSERT INTO categories (category_name) VALUES (?)",
              [category],
              (error, result) => {
                if (error) {
                  console.error("Error creating category:", error);
                  return res
                    .status(500)
                    .json({ error: "Failed to create category" });
                }
                categoryId = result.insertId;
                ensureSubcategoryAndUpdate();
              }
            );
          }
        }
      );

      function ensureSubcategoryAndUpdate() {
        if (!subcategory) {
          return updateProduct(null);
        }

        db.query(
          "SELECT subcategory_id FROM subcategories WHERE subcategory_name = ? AND category_id = ?",
          [subcategory, categoryId],
          (error, results) => {
            if (error) {
              console.error("Error checking subcategory:", error);
              return updateProduct(null);
            }

            if (results.length > 0) {
              return updateProduct(results[0].subcategory_id);
            }

            db.query(
              "INSERT INTO subcategories (subcategory_name, category_id) VALUES (?, ?)",
              [subcategory, categoryId],
              (error, result) => {
                if (error) {
                  console.error("Error creating subcategory:", error);
                  return updateProduct(null);
                }
                return updateProduct(result.insertId);
              }
            );
          }
        );
      }

      function updateProduct(subcategoryId) {
        const withSubQuery =
          "UPDATE products SET product_name = ?, price = ?, stock = ?, category_id = ?, subcategory_id = ?, image_path = ? WHERE product_id = ?";
        const withSubValues = [
          name,
          price,
          stock,
          categoryId,
          subcategoryId,
          image,
          id,
        ];
        const withoutSubQuery =
          "UPDATE products SET product_name = ?, price = ?, stock = ?, category_id = ?, image_path = ? WHERE product_id = ?";
        const withoutSubValues = [name, price, stock, categoryId, image, id];

        db.query(withSubQuery, withSubValues, (error, result) => {
          if (error) {
            if (error.code === "ER_BAD_FIELD_ERROR") {
              return db.query(withoutSubQuery, withoutSubValues, (err2, res2) =>
                handleUpdateResponse(err2, res2)
              );
            }
            return handleUpdateResponse(error, result);
          }
          return handleUpdateResponse(null, result);
        });

        function handleUpdateResponse(error, result) {
          if (error) {
            console.error("Error updating product:", error);
            if (error.code === "ER_DATA_TOO_LONG") {
              return res.status(400).json({
                error:
                  "Image data is too large. Please use a smaller image or compress it further.",
              });
            }
            return res
              .status(500)
              .json({ error: "Failed to update product: " + error.message });
          }

          if (result.affectedRows === 0) {
            return res.status(404).json({ error: "Product not found" });
          }

          // Get updated product with category and subcategory
          db.query(
            "SELECT p.*, c.category_name, sc.subcategory_name FROM products p LEFT JOIN categories c ON p.category_id = c.category_id LEFT JOIN subcategories sc ON p.subcategory_id = sc.subcategory_id WHERE p.product_id = ?",
            [id],
            (fetchError, fetchResults) => {
              if (fetchError) {
                console.error("Error fetching updated product:", fetchError);
                return res
                  .status(500)
                  .json({ error: "Failed to fetch updated product" });
              }

              if (!fetchResults || fetchResults.length === 0) {
                return res.status(404).json({ error: "Product not found" });
              }

              const product = fetchResults[0];
              const updatedProduct = {
                id: parseInt(id),
                name,
                price: parseFloat(price),
                image: image || "https://via.placeholder.com/100",
                category: product.category_name || category,
                subcategory: product.subcategory_name || subcategory || null,
                stock: parseInt(stock),
                is_visible:
                  product.is_visible !== undefined
                    ? product.is_visible !== 0
                    : true,
              };

              const numericStock = parseInt(stock, 10) || 0;
              const stockDifference = numericStock - previousStock;
              const actionType =
                stockDifference > 0
                  ? "restocked"
                  : stockDifference < 0
                  ? "issued"
                  : "updated";

              recordInventoryLog({
                productId: parseInt(id, 10),
                productName: updatedProduct.name || previousProductName,
                actionType,
                quantityChange: stockDifference,
                finalStock: numericStock,
                userId: req.user?.id || null,
                userName: req.user?.name || null,
              });

              res.json(updatedProduct);
            }
          );

          const numericStock = parseInt(stock, 10) || 0;
          const stockDifference = numericStock - previousStock;
          const actionType =
            stockDifference > 0
              ? "restocked"
              : stockDifference < 0
              ? "issued"
              : "updated";

          recordInventoryLog({
            productId: parseInt(id, 10),
            productName: updatedProduct.name || previousProductName,
            actionType,
            quantityChange: stockDifference,
            finalStock: numericStock,
            userId: req.user?.id || null,
            userName: req.user?.name || null,
          });

          res.json(updatedProduct);
        }
      }
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Delete product (staff only)
router.delete(
  "/products/:id",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const query =
        "UPDATE products SET is_deleted = TRUE WHERE product_id = ?";

      db.query(query, [id], (error, result) => {
        if (error) {
          console.error("Error archiving product:", error);
          return res.status(500).json({ error: "Failed to archive product" });
        }

        if (result.affectedRows === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json({ message: "Product archived successfully" });
      });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Get categories
router.get("/categories", async (req, res) => {
  try {
    // replace ORDER BY category_name with explicit order
    const query =
      "SELECT category_name FROM categories ORDER BY FIELD(category_name, 'Rice Meals','Drinks','Sandwiches','Snacks')";

    db.query(query, (error, results) => {
      if (error) {
        console.error("Error fetching categories:", error);
        return res.status(500).json({ error: "Failed to fetch categories" });
      }

      const categories = results.map((cat) => cat.category_name);
      res.json(categories);
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Test endpoint to check if server is working
// Get archived products (staff only)
router.get(
  "/products/archived",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const query = `
      SELECT p.*, c.category_name, sc.subcategory_name 
      FROM products p 
      LEFT JOIN categories c ON p.category_id = c.category_id 
      LEFT JOIN subcategories sc ON p.subcategory_id = sc.subcategory_id
      WHERE p.is_deleted = TRUE 
      ORDER BY p.created_at DESC
    `;

      db.query(query, (error, results) => {
        if (error) {
          console.error("Error fetching archived products:", error);
          return res
            .status(500)
            .json({ error: "Failed to fetch archived products" });
        }

        const products = results.map((product) => ({
          id: product.product_id,
          name: product.product_name,
          price: parseFloat(product.price),
          image: product.image_path || "https://via.placeholder.com/100",
          category: product.category_name || "Uncategorized",
          subcategory: product.subcategory_name || null,
          stock: product.stock,
          is_visible: product.is_visible !== undefined ? product.is_visible !== 0 : true,
        }));

        res.json(products);
      });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Unarchive a product (staff only)
router.post(
  "/products/:id/unarchive",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const { id } = req.params;

      const query =
        "UPDATE products SET is_deleted = FALSE WHERE product_id = ?";

      db.query(query, [id], (error, result) => {
        if (error) {
          console.error("Error unarchiving product:", error);
          return res.status(500).json({ error: "Failed to unarchive product" });
        }

        if (result.affectedRows === 0) {
          return res.status(404).json({ error: "Product not found" });
        }

        res.json({ message: "Product unarchived successfully" });
      });
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// Toggle product visibility (staff only)
router.put(
  "/products/:id/visibility",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { is_visible } = req.body;

      // First, get the current product to return updated data
      db.query(
        "SELECT p.*, c.category_name, sc.subcategory_name FROM products p LEFT JOIN categories c ON p.category_id = c.category_id LEFT JOIN subcategories sc ON p.subcategory_id = sc.subcategory_id WHERE p.product_id = ?",
        [id],
        (error, results) => {
          if (error) {
            console.error("Error fetching product:", error);
            return res.status(500).json({ error: "Failed to fetch product" });
          }

          if (!results || results.length === 0) {
            return res.status(404).json({ error: "Product not found" });
          }

          const product = results[0];

          // Update visibility
          const updateQuery =
            "UPDATE products SET is_visible = ? WHERE product_id = ?";
          db.query(updateQuery, [is_visible ? 1 : 0, id], (error, result) => {
            if (error) {
              console.error("Error updating product visibility:", error);
              return res
                .status(500)
                .json({ error: "Failed to update product visibility" });
            }

            if (result.affectedRows === 0) {
              return res.status(404).json({ error: "Product not found" });
            }

            // Return updated product
            const updatedProduct = {
              id: product.product_id,
              name: product.product_name,
              price: parseFloat(product.price),
              image:
                product.image_path || "https://via.placeholder.com/100",
              category: product.category_name || "Uncategorized",
              subcategory: product.subcategory_name || null,
              stock: product.stock,
              is_visible: is_visible,
            };

            res.json(updatedProduct);
          });
        }
      );
    } catch (error) {
      console.error("Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

router.get("/test", (req, res) => {
  res.json({
    message: "Menu API is working!",
    timestamp: new Date().toISOString(),
  });
});

router.get(
  "/inventory/logs",
  authGuard,
  requireRole("staff"),
  async (req, res) => {
    try {
      await ensureInventoryLogTable();

      const query = `
        SELECT 
          log_id,
          product_id,
          product_name,
          action_type,
          quantity_change,
          final_stock,
          user_id,
          user_name,
          created_at
        FROM inventory_logs
        ORDER BY created_at DESC
        LIMIT 200
     `;

      db.query(query, (error, results) => {
        if (error) {
          console.error("Error fetching inventory logs:", error);
          return res
            .status(500)
            .json({ error: "Failed to fetch inventory logs" });
        }

        res.json(results || []);
      });
    } catch (error) {
      console.error("Error ensuring inventory logs table:", error);
      res.status(500).json({ error: "Failed to load inventory logs" });
    }
  }
);

// Get subcategories for a given category
router.get("/subcategories", async (req, res) => {
  try {
    const { category } = req.query;
    if (!category) {
      return res
        .status(400)
        .json({ error: "category query parameter is required" });
    }

    const q = `
      SELECT sc.subcategory_name
      FROM subcategories sc
      JOIN categories c ON sc.category_id = c.category_id
      WHERE c.category_name = ?
      ORDER BY sc.subcategory_name ASC
    `;

    db.query(q, [category], (error, results) => {
      if (error) {
        console.error("Error fetching subcategories:", error);
        // If subcategories table doesn't exist, return empty list to stay compatible
        if (error.code === "ER_NO_SUCH_TABLE") {
          return res.json([]);
        }
        return res.status(500).json({ error: "Failed to fetch subcategories" });
      }
      res.json(results.map((r) => r.subcategory_name));
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
