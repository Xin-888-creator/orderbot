CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  whatsapp_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  state TEXT NOT NULL DEFAULT 'NEW',
  human_takeover INTEGER NOT NULL DEFAULT 0,
  human_reason TEXT,
  contact_phone TEXT,
  address_text TEXT,
  address_formatted TEXT,
  latitude REAL,
  longitude REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  items_json TEXT NOT NULL DEFAULT '[]',
  raw_text TEXT NOT NULL,
  subtotal REAL,
  currency TEXT NOT NULL DEFAULT 'MYR',
  address_text TEXT,
  address_formatted TEXT,
  latitude REAL,
  longitude REAL,
  contact_phone TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(id)
);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id
ON orders(customer_id);

CREATE INDEX IF NOT EXISTS idx_customers_state
ON customers(state);
