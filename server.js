require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const sql     = require("mssql");

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── CORS ────────────────────────────────────────────────────── */
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"]
}));
app.use(express.json());

/* ── SQL Server config (Azure SQL) ───────────────────────────── */
const dbConfig = {
  server:   process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port:     1433,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt:                true,   // required for Azure
    trustServerCertificate: false,
    enableArithAbort:       true,
    connectTimeout:         30000
  }
};

/* ── Pool ────────────────────────────────────────────────────── */
let pool;
async function getPool() {
  if (pool) return pool;
  pool = await new sql.ConnectionPool(dbConfig).connect();
  console.log(`✅ Connected to ${process.env.DB_DATABASE} on Azure SQL`);
  return pool;
}

/* ════════════════════════════════════════════════
   USER ROUTES
════════════════════════════════════════════════ */

/* GET /api/users */
app.get("/api/users", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().query(`
      SELECT userId, email, role, firstName, lastName, isActive, createdAt
      FROM   [dbo].[User]
      ORDER  BY userId
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error("GET /api/users:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /api/users/:id */
app.get("/api/users/:id", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id", sql.Int, +req.params.id)
      .query(`
        SELECT userId, email, role, firstName, lastName, isActive, createdAt
        FROM   [dbo].[User] WHERE userId = @id
      `);
    if (!r.recordset.length) return res.status(404).json({ error: "User not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/users */
app.post("/api/users", async (req, res) => {
  const { firstName, lastName, email, password, role, isActive } = req.body;
  if (!firstName || !lastName || !email || !password || !role)
    return res.status(400).json({ error: "firstName, lastName, email, password, role are required." });

  try {
    const p = await getPool();

    // Duplicate email check
    const dup = await p.request()
      .input("email", sql.NVarChar, email)
      .query("SELECT 1 FROM [dbo].[User] WHERE email = @email");
    if (dup.recordset.length)
      return res.status(409).json({ error: "Email already exists." });

    // Hash password to match existing $2b$12$ format
    const passwordHash = await hashPw(password);

    const r = await p.request()
      .input("email",        sql.NVarChar, email)
      .input("passwordHash", sql.NVarChar, passwordHash)
      .input("role",         sql.NVarChar, role)
      .input("firstName",    sql.NVarChar, firstName)
      .input("lastName",     sql.NVarChar, lastName)
      .input("isActive",     sql.Bit,      isActive ?? 1)
      .query(`
        INSERT INTO [dbo].[User]
          (email, passwordHash, role, firstName, lastName, isActive, createdAt)
        OUTPUT INSERTED.userId, INSERTED.email, INSERTED.role,
               INSERTED.firstName, INSERTED.lastName,
               INSERTED.isActive,  INSERTED.createdAt
        VALUES (@email, @passwordHash, @role, @firstName, @lastName, @isActive, GETDATE())
      `);
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    console.error("POST /api/users:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* PUT /api/users/:id */
app.put("/api/users/:id", async (req, res) => {
  const { firstName, lastName, email, role, isActive } = req.body;
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id",        sql.Int,      +req.params.id)
      .input("email",     sql.NVarChar, email)
      .input("role",      sql.NVarChar, role)
      .input("firstName", sql.NVarChar, firstName)
      .input("lastName",  sql.NVarChar, lastName)
      .input("isActive",  sql.Bit,      isActive ?? 1)
      .query(`
        UPDATE [dbo].[User]
        SET    email     = @email,
               role      = @role,
               firstName = @firstName,
               lastName  = @lastName,
               isActive  = @isActive
        OUTPUT INSERTED.userId, INSERTED.email, INSERTED.role,
               INSERTED.firstName, INSERTED.lastName,
               INSERTED.isActive,  INSERTED.createdAt
        WHERE  userId = @id
      `);
    if (!r.recordset.length) return res.status(404).json({ error: "User not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    console.error("PUT /api/users:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* DELETE /api/users/:id */
app.delete("/api/users/:id", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id", sql.Int, +req.params.id)
      .query("DELETE FROM [dbo].[User] WHERE userId = @id");
    if (!r.rowsAffected[0]) return res.status(404).json({ error: "User not found" });
    res.json({ success: true, deletedId: +req.params.id });
  } catch (err) {
    console.error("DELETE /api/users:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   COURSE ROUTES
════════════════════════════════════════════════ */

app.get("/api/courses", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().query(`
      SELECT c.courseId, c.title, c.description, c.createdAt,
             u.firstName + ' ' + u.lastName AS instructorName
      FROM   [dbo].[Course] c
      LEFT JOIN [dbo].[User] u ON c.instructorId = u.userId
      ORDER  BY c.courseId
    `);
    res.json(r.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/courses/:id", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id", sql.Int, +req.params.id)
      .query(`
        SELECT c.courseId, c.title, c.description, c.createdAt,
               u.firstName + ' ' + u.lastName AS instructorName
        FROM   [dbo].[Course] c
        LEFT JOIN [dbo].[User] u ON c.instructorId = u.userId
        WHERE  c.courseId = @id
      `);
    if (!r.recordset.length) return res.status(404).json({ error: "Course not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════
   HEALTH CHECK
════════════════════════════════════════════════ */
app.get("/api/health", async (req, res) => {
  try {
    const p = await getPool();
    await p.request().query("SELECT 1 AS ok");
    res.json({ status: "ok", db: "daytona_lms", time: new Date() });
  } catch (err) {
    res.status(500).json({ status: "error", message: err.message });
  }
});

/* ── Password hash helper ────────────────────────────────────── */
async function hashPw(plain) {
  try {
    const bcrypt = require("bcrypt");
    return await bcrypt.hash(plain, 12);
  } catch (_) {
    console.warn("⚠️  bcrypt not available — run: npm install bcrypt");
    return plain; // fallback only; remove in production
  }
}

/* ── Start ───────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n🚀 Daytona LMS API → http://localhost:${PORT}`);
  console.log(`   Health : http://localhost:${PORT}/api/health`);
  console.log(`   Users  : http://localhost:${PORT}/api/users\n`);
  getPool().catch(err => console.error("❌ DB connection failed:", err.message));
});
