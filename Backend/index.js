const express = require('express');
const mysql = require('mysql2/promise');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const saltRounds = 10;
const jwt = require('jsonwebtoken');
const { PassThrough } = require('stream');
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { Readable } = require('stream');
require('dotenv').config();
 
// Initialize Express
const app = express();
const JWT_SECRET = process.env.JWT_SECRET_KEY;
// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
 
// Initialize S3 client
const s3Client = new S3Client({
    region: process.env.AWS_REGION, // e.g., 'us-east-1'
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
  });
  
 
// Configure multer for Vercel - using memory storage instead of disk storage
const storage = multer.memoryStorage();
const upload = multer({ storage });
 
// Initialize PostgreSQL pool
const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});
 
// Helper function to execute queries
const queryPromise = async (text, params) => {
  return await pool.query(text, params).then(res => res.rows);
};
 
// Initialize database tables
const initDB = async () => {
  try {
    // Create tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        product_name VARCHAR(255) NOT NULL,
        serial_number VARCHAR(255) UNIQUE NOT NULL,
        registered_status VARCHAR(255) DEFAULT 'NO'
      )
    `);
 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_registration (
        id SERIAL PRIMARY KEY,
        invoice_id VARCHAR(255),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        mobile_number VARCHAR(20),
        product_name VARCHAR(255) NOT NULL,
        serial_number VARCHAR(255) UNIQUE NOT NULL,
        invoice_receipt TEXT,
        registered_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        customerName VARCHAR(255) NOT NULL,
        customerLocation VARCHAR(255) NOT NULL,
        category TEXT CHECK (category IN ('MSME','Educational Institutions','Datacentres')) NOT NULL,
        participantName VARCHAR(255) NOT NULL,
        participantEmail VARCHAR(255) NOT NULL,
        baseModelSize TEXT CHECK (baseModelSize IN ('>=3B','7B','13B','34B','70B','180B','450B','700B')) NOT NULL,
        isCustom TEXT CHECK (isCustom IN ('Yes','No')) NOT NULL,
        onHuggingFace TEXT CHECK (onHuggingFace IN ('Yes','No')) NOT NULL,
        hfLink VARCHAR(512) NOT NULL,
        architecture VARCHAR(255) NOT NULL,
        workloads TEXT CHECK (workloads IN ('Finetuning','Inference','Both')) NOT NULL,
        infraType TEXT CHECK (infraType IN ('On-premise','Private Cloud','No Existing AI Infrastructure')) NOT NULL,
        motherboard VARCHAR(255),
        processor VARCHAR(255),
        dram VARCHAR(255),
        gpus VARCHAR(255),
        os VARCHAR(255),
        submitted_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255),
        email VARCHAR(255) UNIQUE NOT NULL,
        mobile_number VARCHAR(20),
        password VARCHAR(255),
        role TEXT CHECK (role IN ('customer','employee','admin')),
        registered_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
 
    await pool.query(`
      CREATE TABLE IF NOT EXISTS warranty_status (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255),
        serial_number VARCHAR(255) UNIQUE NOT NULL,
        customer_remarks VARCHAR(255),
        claim_status TEXT CHECK (claim_status IN ('Pending','Approved','Rejected')) DEFAULT 'Pending'
      )
    `);
 
    console.log("✅ CockroachDB tables initialized successfully.");
  } catch (err) {
    console.error("❌ Error during DB initialization:", err.stack);
  }
};
 
// Verify Token Middleware
function verifyToken(req, res, next) {
  const authHeader = req.headers['authorization'];
 
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or malformed' });
  }
 
  const token = authHeader.split(' ')[1];
 
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      console.error('Token verification failed:', err);
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
 
    req.user = user;
    next();
  });
}
 
function verifyAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Access denied: Admins only' });
  }
}
 
// Initialize DB on first load
let dbInitialized = false;
const initializeApp = async () => {
  if (!dbInitialized) {
    await initDB();
    dbInitialized = true;
  }
};
 
// Endpoints
app.post('/login', async (req, res) => {
  await initializeApp();
  console.log(req.body);
  const { email, password } = req.body;
 
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }
 
  try {
    const [user] = await queryPromise('SELECT * FROM users WHERE email = $1', [email]);
 
    if (!user) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
 
    console.log('Attempting login for:', user);
 
    const storedPasswordHash = user.password;
    const match = await bcrypt.compare(password, storedPasswordHash);
    console.log('Password match result:', match);
 
    if (!match) {
      console.log("Password does not match");
      return res.status(401).json({ error: "Invalid password." });
    }
 
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '1d' }
    );
 
    res.json({ message: "Login successful", token, user });
 
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});
 
app.post('/update_password', verifyToken, async (req, res) => {
  await initializeApp();
  const { email, new_password } = req.body;
 
  if (!email || !new_password) {
    return res.status(400).json({ error: "Email and new password are required." });
  }
 
  try {
    const users = await queryPromise('SELECT * FROM users WHERE email = $1', [email]);
    const user = users[0];
 
    if (!user) {
      return res.status(404).json({ error: "User not found." });
    }
 
    const hashedNewPassword = await bcrypt.hash(new_password, saltRounds);
    await queryPromise('UPDATE users SET password = $1 WHERE email = $2', [hashedNewPassword, email]);
 
    res.json({ message: "Password updated successfully." });
  } catch (err) {
    console.error("Error updating password:", err);
    res.status(500).json({ error: "Server error" });
  }
});
 
app.get('/user_registrations/:email', verifyToken, async (req, res) => {
  await initializeApp();
  const { email } = req.params;
 
  try {
    const registrations = await queryPromise(`
      SELECT
        u.name AS user_name,
        u.email,
        u.mobile_number,
        pr.invoice_id,
        pr.product_name,
        pr.serial_number,
        pr.invoice_receipt,
        pr.registered_at
      FROM users u
      JOIN product_registration pr ON u.email = pr.email
      WHERE u.email = $1
    `, [email]);
 
    if (registrations.length === 0) {
      return res.status(404).json({ message: "No registrations found for this email." });
    }
 
    res.json({ registrations });
 
  } catch (err) {
    console.error("Error fetching registrations:", err);
    res.status(500).json({ error: "Server error" });
  }
});
 
app.get('/registered_users', verifyToken, verifyAdmin, async (req, res) => {
  await initializeApp();
  try {
    const registrations = await queryPromise(`
      SELECT * FROM product_registration
    `, []);
 
    if (registrations.length === 0) {
      return res.status(404).json({ message: "No Products registered for warranty" });
    }
 
    res.json({ registrations });
 
  } catch (err) {
    console.error("Error fetching registrations:", err);
    res.status(500).json({ error: "Server error" });
  }
});
 
app.get('/registered_warranty_claims', verifyToken, verifyAdmin, async (req, res) => {
  await initializeApp();
  try {
    const registrations = await queryPromise(`
      SELECT * FROM warranty_status
    `, []);
 
    if (registrations.length === 0) {
      return res.status(404).json({ message: "No Warranty Claims Available" });
    }
 
    res.json({ registrations });
 
  } catch (err) {
    console.error("Error fetching registrations:", err);
    res.status(500).json({ error: "Server error" });
  }
});
 
app.get('/shipped_products', verifyToken, verifyAdmin, async (req, res) => {
  await initializeApp();
  try {
    const registrations = await queryPromise(`
      SELECT * FROM products
    `, []);
 
    if (registrations.length === 0) {
      return res.status(404).json({ message: "No Products Available" });
    }
 
    res.json({ registrations });
 
  } catch (err) {
    console.error("Error fetching registrations:", err);
    res.status(500).json({ error: "Server error" });
  }
});
 
app.post('/warranty', verifyToken, async (req, res) => {
  await initializeApp();
  const { email, serial_number, customer_remarks } = req.body;
 
  if (!serial_number) {
    return res.status(400).json({ error: 'Serial number is required.' });
  }
 
  try {
    const query = `
      INSERT INTO warranty_status (email, serial_number, customer_remarks)
      VALUES ($1, $2, $3)
      RETURNING id
    `;
 
    const [inserted] = await queryPromise(query, [email, serial_number, customer_remarks]);
 
    res.status(201).json({ message: 'Warranty record inserted', id: inserted.id });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Warranty already claimed for this serial number.' });
    }
    console.error("Error inserting warranty record:", err);
    res.status(500).json({ error: 'Database error', details: err.message });
  }
});
 
app.post('/warranty_status', verifyToken, verifyAdmin, async (req, res) => {
  await initializeApp();
  const { serial_number, claim_status } = req.body;
 
  if (!serial_number || !claim_status) {
    return res.status(400).json({ error: "Serial number and claim status are required." });
  }
 
  try {
    const records = await queryPromise('SELECT * FROM warranty_status WHERE serial_number = $1', [serial_number]);
 
    if (records.length === 0) {
      return res.status(404).json({ error: "Warranty record not found." });
    }
 
    await queryPromise('UPDATE warranty_status SET claim_status = $1 WHERE serial_number = $2', [claim_status, serial_number]);
 
    res.json({ message: "Claim status updated successfully." });
  } catch (err) {
    console.error("Error updating claim status:", err);
    res.status(500).json({ error: err.message });
  }
});
 
app.get("/get_warranty/:serial_number", verifyToken, async (req, res) => {
  await initializeApp();
  try {
    const { serial_number } = req.params;
 
    const result = await queryPromise(
      'SELECT * FROM warranty_status WHERE serial_number = $1',
      [serial_number]
    );
 
    if (result.length === 0) {
      return res.status(404).json({ error: "Warranty record not found." });
    }
 
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
 
app.get('/products', verifyToken, verifyAdmin, async (req, res) => {
  await initializeApp();
  try {
    const result = await pool.query('SELECT * FROM products ORDER BY id ASC');
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.delete('/products/:serial_number', verifyToken, verifyAdmin, async (req, res) => {
  await initializeApp();
  const { serial_number } = req.params;
 
  if (!serial_number) {
    return res.status(400).json({ error: 'Serial number is required' });
  }
 
  try {
    const checkResult = await pool.query(
      'SELECT * FROM products WHERE serial_number = $1',
      [serial_number]
    );
 
    if (checkResult.rowCount === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }
    const result = await pool.query(
      'DELETE FROM products WHERE serial_number = $1 RETURNING *',
      [serial_number]
    );
 
    res.status(200).json({
      message: 'Product deleted successfully',
      deleted_product: result.rows[0]
    });
  } catch (err) {
    console.error('Error deleting product:', err);
    res.status(500).json({ error: 'Server error while deleting product' });
  }
});
 
app.get('/download/invoice/:serial_number',  verifyToken ,  async (req, res) => {
  await initializeApp();
  try {
    const { serial_number } = req.params;
 
    const rows = await queryPromise(
      'SELECT invoice_receipt, product_name FROM product_registration WHERE serial_number = $1',
      [serial_number]
    );
 
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }
 
    const invoice = rows[0];
        const key = invoice.invoice_receipt;
    
        const command = new GetObjectCommand({
          Bucket: process.env.AWS_S3_BUCKET,
          Key: key
        });
    
        const data = await s3Client.send(command);
    
        // Set headers
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${invoice.product_name}-invoice.pdf"`
        );
    
        // Pipe the stream
        const stream = data.Body instanceof Readable ? data.Body : Readable.from(data.Body);
        stream.pipe(res).on('error', (err) => {
          console.error('Stream error:', err);
          res.status(500).json({ error: 'Failed to stream file' });
        });
  } catch (err) {
    console.error('Error downloading file:', err);
    res.status(500).json({ error: 'Server error' });
  }
});
 
app.post('/product_registration', upload.single('invoice_receipt'), async (req, res) => {
  await initializeApp();
  const {
    invoice_id, name, email, mobile_number,
    product_name, serial_number
  } = req.body;
 
  const productNames = Array.isArray(product_name) ? product_name : [product_name];
  const serialNumbers = Array.isArray(serial_number) ? serial_number : [serial_number];
 
  if (productNames.length !== serialNumbers.length) {
    return res.status(400).json({ error: "Mismatched product and serial number counts." });
  }
 
  let s3Key = null;
 
  try {
    // Upload file to S3
    if (req.file) {
  
     
            const fileName = `invoices/${Date.now()}_${req.file.originalname}`;
          
            const upload = new Upload({
              client: s3Client,
              params: {
                Bucket: process.env.AWS_S3_BUCKET,
                Key: fileName,
                Body: req.file.buffer,
                ContentType: req.file.mimetype
              }
            });
          
            await upload.done();
            s3Key = fileName;
          
           
    }
 
    // Check if user exists
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const existingUser = userResult.rows[0];
    let generatedPassword = null;
 
    if (!existingUser) {
      generatedPassword = crypto.randomBytes(6).toString('hex');
      const hashedPassword = await bcrypt.hash(generatedPassword, 10);
 
      await pool.query(
        'INSERT INTO users (name, email, mobile_number, password, role) VALUES ($1, $2, $3, $4, $5)',
        [name, email, mobile_number, hashedPassword, "customer"]
      );
    }
 
    // Validate products
    for (let i = 0; i < productNames.length; i++) {
      const productResult = await pool.query(
        'SELECT registered_status FROM products WHERE product_name = $1 AND serial_number = $2',
        [productNames[i], serialNumbers[i]]
      );
 
      const product = productResult.rows[0];
 
      if (!product) {
        return res.status(400).json({
          error: `Product not found: "${productNames[i]}" - "${serialNumbers[i]}"`
        });
      }
 
      if (product.registered_status !== "NO") {
        return res.status(400).json({
          error: `Warranty claim already submitted for "${productNames[i]}" - "${serialNumbers[i]}"`
        });
      }
    }
 
    // Insert registrations
    const insertPromises = productNames.map((pname, i) => {
      return pool.query(
        `INSERT INTO product_registration
         (invoice_id, name, email, mobile_number, product_name, serial_number, invoice_receipt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [invoice_id, name, email, mobile_number, pname, serialNumbers[i], s3Key]
      );
    });
 
    // Update product registration status
    const updatePromises = productNames.map((pname, i) => {
      return pool.query(
        'UPDATE products SET registered_status = $1 WHERE product_name = $2 AND serial_number = $3',
        ['YES', pname, serialNumbers[i]]
      );
    });
 
    await Promise.all([...insertPromises, ...updatePromises]);
 
    res.json({
      message: "Product(s) registered successfully",
      inserted: productNames.length,
      // receipt: s3Key,
      ...(generatedPassword && { temp_password: generatedPassword })
    });
 
  } catch (err) {
    console.error("Error during product registration:", err);
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/update_temp_password', verifyToken, async (req, res) => {
  await initializeApp();
  const { email } = req.body;
 
  try {
    // Check if user exists
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const existingUser = userResult.rows[0];
 
    if (!existingUser) {
      return res.status(404).json({ error: 'User not found.' });
    }
 
    // Generate and hash a temporary password
    const generatedPassword = crypto.randomBytes(6).toString('hex');
    const hashedPassword = await bcrypt.hash(generatedPassword, saltRounds);
 
    // Update user's password
    await pool.query(
      'UPDATE users SET password = $1 WHERE email = $2',
      [hashedPassword, email]
    );
 
    res.json({
      message: 'Temporary password updated successfully.',
      temp_password: generatedPassword
    });
 
  } catch (err) {
    console.error("Error updating temporary password:", err);
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/customers', async (req, res) => {
  await initializeApp();
  try {
    const {
      customerName,
      customerLocation,
      category,
      participants,
      baseModelSize,
      isCustom,
      onHuggingFace,
      hfLink,
      architecture,
      workloads,
      infraType,
      motherboard,
      processor,
      dram,
      gpus,
      os
    } = req.body;
 
    // Validate participants
    if (!participants || typeof participants !== 'string') {
      return res.status(400).json({ error: 'Participants field is required and must be a string.' });
    }
 
    const firstEntry = participants.split(';')[0].trim();
    const parts = firstEntry.split(/\s*[-–]\s*/);
    const namePart = parts[0]?.trim();
    const emailPart = parts[1]?.trim();
 
    if (!emailPart || !emailPart.match(/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/)) {
      return res.status(400).json({ error: 'Please use "Name – valid@email.com" in Participants.' });
    }
 
    // Convert booleans to 'Yes'/'No'
    const isCustomStr = isCustom ? 'Yes' : 'No';
    const onHuggingFaceStr = onHuggingFace ? 'Yes' : 'No';
 
    // Validate ENUM values
    const validCategories = ['MSME', 'Educational Institutions', 'Datacentres'];
    const validModelSizes = ['>=3B', '7B', '13B', '34B', '70B', '180B', '450B', '700B'];
    const validWorkloads = ['Finetuning', 'Inference', 'Both'];
    const validInfraTypes = ['On-premise', 'Private Cloud', 'No Existing AI Infrastructure'];
 
    if (!validCategories.includes(category)) {
      return res.status(400).json({ error: `Invalid category. Must be one of: ${validCategories.join(', ')}` });
    }
 
    if (!validModelSizes.includes(baseModelSize)) {
      return res.status(400).json({ error: `Invalid baseModelSize. Must be one of: ${validModelSizes.join(', ')}` });
    }
 
    if (!validWorkloads.includes(workloads)) {
      return res.status(400).json({ error: `Invalid workload. Must be one of: ${validWorkloads.join(', ')}` });
    }
 
    if (!validInfraTypes.includes(infraType)) {
      return res.status(400).json({ error: `Invalid infraType. Must be one of: ${validInfraTypes.join(', ')}` });
    }
 
    const sql = `
    INSERT INTO customers (
      customerName,
      customerLocation,
      category,
      participantName,
      participantEmail,
      baseModelSize,
      isCustom,
      onHuggingFace,
      hfLink,
      architecture,
      workloads,
      infraType,
      motherboard,
      processor,
      dram,
      gpus,
      os
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
    ) RETURNING id
    `;
   
    const params = [
      customerName,
      customerLocation,
      category,
      namePart,
      emailPart,
      baseModelSize,
      isCustomStr,
      onHuggingFaceStr,
      hfLink,
      architecture,
      workloads,
      infraType,
      motherboard,
      processor,
      dram,
      gpus,
      os
    ];
 
    const result = await queryPromise(sql, params);
    res.json({ message: "Customer inserted successfully", id: result[0]?.id || null });
 
  } catch (err) {
    console.error('❌ DB error:', err);
    res.status(500).json({ error: err.message });
  }
});
 
app.post('/products', verifyToken, verifyAdmin, async (req, res) => {
  await initializeApp();
  const { product_name, serial_number } = req.body;
 
  if (!product_name || !serial_number) {
    return res.status(400).json({ error: 'Both product_name and serial_number are required.' });
  }
 
  try {
    const insertQuery = `
      INSERT INTO products (product_name, serial_number)
      VALUES ($1, $2)
    `;
    await pool.query(insertQuery, [product_name, serial_number]);
 
    res.json({ message: 'Product inserted successfully.' });
  } catch (err) {
    console.error('Error inserting product:', err);
    res.status(500).json({ error: 'Duplicate Entry' });
  }
});
 
// Health check route
app.get('/health', async (req, res) => {
  await initializeApp();
  res.send('OK');
});
 
// PORT = 3002
// app.listen(PORT, () => {
//     console.log(`🚀 Server is running on http://localhost:${PORT}`);
//   });
// Export the Express API as a Vercel serverless function
module.exports = app;