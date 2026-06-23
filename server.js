const express = require('express');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON parser for simulations
app.use(express.json());

// Serve static files from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Database File Path
const DB_PATH = path.join(__dirname, 'products.db');
const db = new DatabaseSync(DB_PATH);

console.log(`Database initialized at: ${DB_PATH}`);

// Initialize SQLite Schema and Indexes
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_products_category_created_at_id 
  ON products(category, created_at DESC, id DESC)
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_products_created_at_id 
  ON products(created_at DESC, id DESC)
`);

// Mock Data Generators
const ADJECTIVES = ["Premium", "Eco-Friendly", "Wireless", "Ultra-Thin", "Smart", "Portable", "Ergonomic", "Heavy-Duty", "Waterproof", "Digital", "Luxury", "Classic", "Vintage", "Minimalist", "High-Performance"];
const NOUNS = ["Headphones", "Backpack", "Smartwatch", "Desk Lamp", "Water Bottle", "Coffee Maker", "Keyboard", "Mouse", "Running Shoes", "Yoga Mat", "Blender", "Vacuum Cleaner", "Air Purifier", "Camping Tent", "Power Bank", "Tablet Stand", "Chef Knife", "Sunglasses", "Leather Wallet", "Screwdriver Set"];
const CATEGORIES = ["Electronics", "Apparel", "Home & Kitchen", "Sports & Outdoors", "Beauty & Health", "Books & Stationery", "Toys & Games", "Automotive", "Garden & Outdoor", "Office Supplies"];

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateProductName() {
  return `${getRandomElement(ADJECTIVES)} ${getRandomElement(NOUNS)}`;
}

function generateProductPrice() {
  return parseFloat((Math.random() * 995 + 5).toFixed(2)); // $5.00 to $1000.00
}

// Seeder function to insert N products
function seedDatabase(totalCount) {
  console.log(`Checking database population...`);
  
  // Check if we already have products
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM products').get();
  if (countRow && countRow.count >= totalCount) {
    console.log(`Database already has ${countRow.count} products. Skipping seeding.`);
    return;
  }

  console.log(`Seeding database with ${totalCount} products...`);
  const start = performance.now();

  // Clear existing
  db.exec('DELETE FROM products');
  db.exec("DELETE FROM sqlite_sequence WHERE name='products'");

  const insertStmt = db.prepare(`
    INSERT INTO products (name, category, price, created_at)
    VALUES (?, ?, ?, ?)
  `);

  db.exec('BEGIN TRANSACTION');
  try {
    const baseTime = Date.now();
    for (let i = 0; i < totalCount; i++) {
      const name = generateProductName();
      const category = getRandomElement(CATEGORIES);
      const price = generateProductPrice();
      // Backdate each product by 1 second to create a stable timeline
      const createdAt = baseTime - (totalCount - i) * 1000;

      insertStmt.run(name, category, price, createdAt);
    }
    db.exec('COMMIT');
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);
    console.log(`Successfully seeded ${totalCount} products in ${elapsed} seconds!`);
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Failed to seed database:', error);
    throw error;
  }
}

// Seed the DB with 200,000 items on startup
seedDatabase(200000);

// Helper functions for Keyset Cursors (Base64 encoded JSON)
function encodeCursor(createdAt, id) {
  const cursorObj = { created_at: createdAt, id };
  return Buffer.from(JSON.stringify(cursorObj)).toString('base64');
}

function decodeCursor(cursorStr) {
  try {
    const json = Buffer.from(cursorStr, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    if (typeof obj.created_at === 'number' && typeof obj.id === 'number') {
      return obj;
    }
  } catch (e) {
    // Return null on invalid cursor
  }
  return null;
}

/**
 * Endpoint to list products (Keyset or Offset)
 */
app.get('/api/products', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const category = req.query.category || null;
  const mode = req.query.mode === 'offset' ? 'offset' : 'keyset';

  let rows = [];
  let queryTime = 0;
  let nextCursor = null;

  try {
    const start = performance.now();

    if (mode === 'offset') {
      const offset = Math.max(parseInt(req.query.offset) || 0, 0);
      
      let stmt;
      if (category) {
        stmt = db.prepare(`
          SELECT id, name, category, price, created_at
          FROM products
          WHERE category = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `);
        rows = stmt.all(category, limit + 1, offset);
      } else {
        stmt = db.prepare(`
          SELECT id, name, category, price, created_at
          FROM products
          ORDER BY created_at DESC, id DESC
          LIMIT ? OFFSET ?
        `);
        rows = stmt.all(limit + 1, offset);
      }
      queryTime = performance.now() - start;

      const hasMore = rows.length > limit;
      if (hasMore) {
        rows.pop(); // Remove the lookahead row
      }

      res.json({
        products: rows,
        pagination: {
          mode: 'offset',
          limit,
          offset,
          has_more: hasMore,
          next_offset: hasMore ? offset + limit : null
        },
        executionTimeMs: parseFloat(queryTime.toFixed(3))
      });

    } else {
      // Keyset Pagination
      const cursorStr = req.query.cursor;
      const cursor = cursorStr ? decodeCursor(cursorStr) : null;

      let stmt;
      if (category) {
        if (cursor) {
          stmt = db.prepare(`
            SELECT id, name, category, price, created_at
            FROM products
            WHERE category = ? AND (created_at < ? OR (created_at = ? AND id < ?))
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `);
          rows = stmt.all(category, cursor.created_at, cursor.created_at, cursor.id, limit + 1);
        } else {
          stmt = db.prepare(`
            SELECT id, name, category, price, created_at
            FROM products
            WHERE category = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `);
          rows = stmt.all(category, limit + 1);
        }
      } else {
        if (cursor) {
          stmt = db.prepare(`
            SELECT id, name, category, price, created_at
            FROM products
            WHERE (created_at < ? OR (created_at = ? AND id < ?))
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `);
          rows = stmt.all(cursor.created_at, cursor.created_at, cursor.id, limit + 1);
        } else {
          stmt = db.prepare(`
            SELECT id, name, category, price, created_at
            FROM products
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `);
          rows = stmt.all(limit + 1);
        }
      }
      queryTime = performance.now() - start;

      const hasMore = rows.length > limit;
      if (hasMore) {
        rows.pop(); // Remove lookahead row
        const lastItem = rows[rows.length - 1];
        nextCursor = encodeCursor(lastItem.created_at, lastItem.id);
      }

      res.json({
        products: rows,
        pagination: {
          mode: 'keyset',
          limit,
          next_cursor: nextCursor,
          has_more: hasMore
        },
        executionTimeMs: parseFloat(queryTime.toFixed(3))
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Simulate: Add 50 new products at the top (with a newer timestamp)
 */
app.post('/api/products/simulate-new', (req, res) => {
  const count = parseInt(req.body.count) || 50;
  const addedProducts = [];

  const maxTimeRow = db.prepare('SELECT MAX(created_at) AS max_time FROM products').get();
  // Ensure the new timestamps are strictly greater than any existing timestamp
  let baseTime = Math.max(maxTimeRow ? maxTimeRow.max_time : 0, Date.now()) + 1000;

  const insertStmt = db.prepare(`
    INSERT INTO products (name, category, price, created_at)
    VALUES (?, ?, ?, ?)
  `);

  db.exec('BEGIN TRANSACTION');
  try {
    for (let i = 0; i < count; i++) {
      const name = generateProductName();
      const category = getRandomElement(CATEGORIES);
      const price = generateProductPrice();
      // Incremented by 1ms each to preserve unique, stable order
      const createdAt = baseTime + i;

      insertStmt.run(name, category, price, createdAt);

      // Get the last inserted ID
      const lastIdRow = db.prepare('SELECT last_insert_rowid() AS id').get();
      addedProducts.push({
        id: lastIdRow.id,
        name,
        category,
        price,
        created_at: createdAt
      });
    }
    db.exec('COMMIT');
    res.json({ message: `Successfully added ${count} new products at the top!`, products: addedProducts });
  } catch (error) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Simulate: Update 50 random products
 */
app.post('/api/products/simulate-update', (req, res) => {
  const count = parseInt(req.body.count) || 50;
  
  try {
    // Select 50 random product IDs
    const randomIds = db.prepare('SELECT id FROM products ORDER BY RANDOM() LIMIT ?').all(count);
    
    if (randomIds.length === 0) {
      return res.json({ message: "No products to update.", updatedCount: 0 });
    }

    const updateStmt = db.prepare(`
      UPDATE products 
      SET price = ?, name = '[UPDATED] ' || name
      WHERE id = ?
    `);

    db.exec('BEGIN TRANSACTION');
    for (const row of randomIds) {
      const newPrice = generateProductPrice();
      updateStmt.run(newPrice, row.id);
    }
    db.exec('COMMIT');

    res.json({ message: `Successfully updated ${randomIds.length} random products in place!`, updatedCount: randomIds.length });
  } catch (error) {
    db.exec('ROLLBACK');
    res.status(500).json({ error: error.message });
  }
});

/**
 * Reset database: deletes everything and reseeds to 200,000 products
 */
app.post('/api/products/reset', (req, res) => {
  try {
    seedDatabase(200000);
    res.json({ message: "Database successfully reset and reseeded to 200,000 products." });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get stats about database
 */
app.get('/api/stats', (req, res) => {
  try {
    const countRow = db.prepare('SELECT COUNT(*) AS count FROM products').get();
    const categoriesRow = db.prepare('SELECT category, COUNT(*) AS count FROM products GROUP BY category ORDER BY category ASC').all();
    res.json({
      totalCount: countRow.count,
      categories: categoriesRow
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start express server
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
