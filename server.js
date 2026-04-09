require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const sql     = require("mssql");

const app  = express();
const PORT = process.env.PORT || 3000;
const crypto        = require("crypto");

/* In-memory reset token store: token -> { userId, email, expires } */
const resetTokens   = new Map();

/* Nodemailer transporter — configure via Render environment variables:
   EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM          */
const nodemailer     = require("nodemailer");
const emailTransport = nodemailer.createTransport({
  host:   process.env.EMAIL_HOST || "smtp.gmail.com",
  port:   parseInt(process.env.EMAIL_PORT || "587"),
  secure: true,   // port 465 + SSL — required on Render free tier (port 587 is blocked)
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});


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

/* ════════════════════════════════════════════════════════════════
   USER ROUTES
════════════════════════════════════════════════════════════════ */

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

/* ════════════════════════════════════════════════════════════════
   COURSE ROUTES
   Table: dbo.Course
   Columns: courseId (PK, identity), CourseTitle, Remarks,
            isPublished, createdAt, instructorId (FK→User),
            status, EditedDate
════════════════════════════════════════════════════════════════ */

/* GET /api/courses */
app.get("/api/courses", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request().query(`
      SELECT c.courseId, c.CourseTitle, c.Remarks, c.isPublished,
             c.createdAt, c.instructorId, c.status, c.EditedDate
      FROM   [dbo].[Course] c
      ORDER  BY c.courseId
    `);
    res.json(r.recordset);
  } catch (err) {
    console.error("GET /api/courses:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /api/courses/:id */
app.get("/api/courses/:id", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id", sql.Int, +req.params.id)
      .query(`
        SELECT c.courseId, c.CourseTitle, c.Remarks, c.isPublished,
               c.createdAt, c.instructorId, c.status, c.EditedDate
        FROM   [dbo].[Course] c
        WHERE  c.courseId = @id
      `);
    if (!r.recordset.length) return res.status(404).json({ error: "Course not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/courses */
app.post("/api/courses", async (req, res) => {
  const { CourseTitle, Remarks, instructorId, status, isPublished } = req.body;
  if (!CourseTitle || !instructorId)
    return res.status(400).json({ error: "CourseTitle and instructorId are required." });

  try {
    const p = await getPool();
    const r = await p.request()
      .input("CourseTitle",  sql.NVarChar, CourseTitle)
      .input("Remarks",     sql.NVarChar, Remarks || "")
      .input("instructorId",sql.Int,       instructorId)
      .input("status",      sql.NChar,     status || "Active")
      .input("isPublished", sql.Bit,       isPublished ?? true)
      .query(`
        INSERT INTO [dbo].[Course]
          (CourseTitle, Remarks, instructorId, status, isPublished, createdAt, EditedDate)
        OUTPUT INSERTED.courseId, INSERTED.CourseTitle, INSERTED.Remarks,
               INSERTED.instructorId, INSERTED.status, INSERTED.isPublished,
               INSERTED.createdAt, INSERTED.EditedDate
        VALUES (@CourseTitle, @Remarks, @instructorId, @status, @isPublished, GETDATE(), GETDATE())
      `);
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    console.error("POST /api/courses:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* PUT /api/courses/:id */
app.put("/api/courses/:id", async (req, res) => {
  const { CourseTitle, Remarks, instructorId, status, isPublished } = req.body;
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id",           sql.Int,      +req.params.id)
      .input("CourseTitle",  sql.NVarChar, CourseTitle)
      .input("Remarks",     sql.NVarChar, Remarks || "")
      .input("instructorId",sql.Int,       instructorId)
      .input("status",      sql.NChar,     status || "Active")
      .input("isPublished", sql.Bit,       isPublished ?? true)
      .query(`
        UPDATE [dbo].[Course]
        SET    CourseTitle  = @CourseTitle,
               Remarks     = @Remarks,
               instructorId= @instructorId,
               status      = @status,
               isPublished = @isPublished,
               EditedDate  = GETDATE()
        OUTPUT INSERTED.courseId, INSERTED.CourseTitle, INSERTED.Remarks,
               INSERTED.instructorId, INSERTED.status, INSERTED.isPublished,
               INSERTED.createdAt, INSERTED.EditedDate
        WHERE  courseId = @id
      `);
    if (!r.recordset.length) return res.status(404).json({ error: "Course not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    console.error("PUT /api/courses:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* DELETE /api/courses/:id */
app.delete("/api/courses/:id", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id", sql.Int, +req.params.id)
      .query("DELETE FROM [dbo].[Course] WHERE courseId = @id");
    if (!r.rowsAffected[0]) return res.status(404).json({ error: "Course not found" });
    res.json({ success: true, deletedId: +req.params.id });
  } catch (err) {
    console.error("DELETE /api/courses:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   COURSE_LESSONS ROUTES
   Table: dbo.Course_Lessons
   PK: (CourseID, LessonId)  — composite
   Columns: CourseID, LessonId, ContentID, Title, Content, URL,
            DurationMinutes, IsExternalLink, FileSizeBytes,
            UploadDate, CreatedAt, UpdatedAt, WeekNumber, Status
════════════════════════════════════════════════════════════════ */

/* GET /api/courses/:courseId/lessons — all lessons for a course */
app.get("/api/courses/:courseId/lessons", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("courseId", sql.Int, +req.params.courseId)
      .query(`
        SELECT CourseID, LessonId, Title, Content, WeekNumber, Status,
               CreatedAt, UpdatedAt
        FROM   [dbo].[Course_Lessons]
        WHERE  CourseID = @courseId
        ORDER  BY WeekNumber, LessonId
      `);
    res.json(r.recordset);
  } catch (err) {
    console.error("GET /api/courses/:courseId/lessons:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /api/courses/:courseId/lessons/:lessonId — single lesson */
app.get("/api/courses/:courseId/lessons/:lessonId", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("courseId",  sql.Int, +req.params.courseId)
      .input("lessonId",  sql.Int, +req.params.lessonId)
      .query(`
        SELECT CourseID, LessonId, Title, Content, WeekNumber, Status,
               CreatedAt, UpdatedAt
        FROM   [dbo].[Course_Lessons]
        WHERE  CourseID = @courseId AND LessonId = @lessonId
      `);
    if (!r.recordset.length) return res.status(404).json({ error: "Lesson not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/courses/:courseId/lessons
   NOTE: LessonId must reference an existing row in dbo.Lesson
   (FK_CourseLessons_Lesson). If you want to auto-create in Lesson first,
   that logic can be added here. For now, LessonId is passed in the body. */
app.post("/api/courses/:courseId/lessons", async (req, res) => {
  const courseId = +req.params.courseId;
  const { LessonId, Title, Content, WeekNumber, Status } = req.body;

  if (!LessonId && !Title)
    return res.status(400).json({ error: "LessonId or Title is required." });

  try {
    const p = await getPool();

    // If no LessonId provided, create a row in dbo.Lesson first
    let lessonId = LessonId;
    if (!lessonId) {
      const lr = await p.request()
        .input("title",       sql.NVarChar, Title)
        .input("content",     sql.NVarChar, Content || "")
        .input("contentType", sql.NVarChar, "text")
        .input("orderIndex",  sql.Int,      WeekNumber || 1)
        .input("moduleId",    sql.Int,      1) // default module; adjust as needed
        .query(`
          INSERT INTO [dbo].[Lesson] (title, content, contentType, orderIndex, moduleId)
          OUTPUT INSERTED.lessonId
          VALUES (@title, @content, @contentType, @orderIndex, @moduleId)
        `);
      lessonId = lr.recordset[0].lessonId;
    }

    // Insert into Course_Lessons junction table
    const r = await p.request()
      .input("courseId",   sql.Int,      courseId)
      .input("lessonId",   sql.Int,      lessonId)
      .input("title",      sql.NVarChar, Title || "")
      .input("content",    sql.NVarChar, Content || "")
      .input("weekNumber", sql.Int,      WeekNumber || null)
      .input("status",     sql.NVarChar, Status || "Active")
      .query(`
        INSERT INTO [dbo].[Course_Lessons]
          (CourseID, LessonId, Title, Content, WeekNumber, Status, CreatedAt, UpdatedAt)
        OUTPUT INSERTED.CourseID, INSERTED.LessonId, INSERTED.Title,
               INSERTED.Content, INSERTED.WeekNumber, INSERTED.Status,
               INSERTED.CreatedAt, INSERTED.UpdatedAt
        VALUES (@courseId, @lessonId, @title, @content, @weekNumber, @status,
                SYSUTCDATETIME(), SYSUTCDATETIME())
      `);
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    console.error("POST /api/courses/:courseId/lessons:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* PUT /api/courses/:courseId/lessons/:lessonId */
app.put("/api/courses/:courseId/lessons/:lessonId", async (req, res) => {
  const { Title, Content, WeekNumber, Status } = req.body;
  try {
    const p = await getPool();
    const r = await p.request()
      .input("courseId",   sql.Int,      +req.params.courseId)
      .input("lessonId",   sql.Int,      +req.params.lessonId)
      .input("title",      sql.NVarChar, Title)
      .input("content",    sql.NVarChar, Content || "")
      .input("weekNumber", sql.Int,      WeekNumber || null)
      .input("status",     sql.NVarChar, Status || "Active")
      .query(`
        UPDATE [dbo].[Course_Lessons]
        SET    Title      = @title,
               Content    = @content,
               WeekNumber = @weekNumber,
               Status     = @status,
               UpdatedAt  = SYSUTCDATETIME()
        OUTPUT INSERTED.CourseID, INSERTED.LessonId, INSERTED.Title,
               INSERTED.Content, INSERTED.WeekNumber, INSERTED.Status,
               INSERTED.CreatedAt, INSERTED.UpdatedAt
        WHERE  CourseID = @courseId AND LessonId = @lessonId
      `);
    if (!r.recordset.length) return res.status(404).json({ error: "Lesson not found" });
    res.json(r.recordset[0]);
  } catch (err) {
    console.error("PUT /api/courses/:courseId/lessons/:lessonId:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* DELETE /api/courses/:courseId/lessons/:lessonId */
app.delete("/api/courses/:courseId/lessons/:lessonId", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("courseId", sql.Int, +req.params.courseId)
      .input("lessonId", sql.Int, +req.params.lessonId)
      .query("DELETE FROM [dbo].[Course_Lessons] WHERE CourseID = @courseId AND LessonId = @lessonId");
    if (!r.rowsAffected[0]) return res.status(404).json({ error: "Lesson not found" });
    res.json({ success: true, deletedCourseId: +req.params.courseId, deletedLessonId: +req.params.lessonId });
  } catch (err) {
    console.error("DELETE lesson:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ════════════════════════════════════════════════════════════════
   COURSE LESSON MATERIAL ROUTES
   Table: dbo.CourseLessonMaterial
   PK: MaterialId (identity)
   FK: (CourseID, LessonId) → Course_Lessons
   Columns: MaterialId, CourseID, LessonId, Title, MaterialType,
            URL, FilePath, FileName, FileSizeBytes, CreatedAt, UpdatedAt
════════════════════════════════════════════════════════════════ */

/* GET /api/courses/:courseId/materials — all materials for a course */
app.get("/api/courses/:courseId/materials", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("courseId", sql.Int, +req.params.courseId)
      .query(`
        SELECT MaterialId, CourseID, LessonId, Title, MaterialType,
               URL, FilePath, FileName, FileSizeBytes, CreatedAt, UpdatedAt
        FROM   [dbo].[CourseLessonMaterial]
        WHERE  CourseID = @courseId
        ORDER  BY LessonId, MaterialId
      `);
    res.json(r.recordset);
  } catch (err) {
    console.error("GET /api/courses/:courseId/materials:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* GET /api/courses/:courseId/lessons/:lessonId/materials — materials for a specific lesson */
app.get("/api/courses/:courseId/lessons/:lessonId/materials", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("courseId", sql.Int, +req.params.courseId)
      .input("lessonId", sql.Int, +req.params.lessonId)
      .query(`
        SELECT MaterialId, CourseID, LessonId, Title, MaterialType,
               URL, FilePath, FileName, FileSizeBytes, CreatedAt, UpdatedAt
        FROM   [dbo].[CourseLessonMaterial]
        WHERE  CourseID = @courseId AND LessonId = @lessonId
        ORDER  BY MaterialId
      `);
    res.json(r.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* POST /api/courses/:courseId/lessons/:lessonId/materials */
app.post("/api/courses/:courseId/lessons/:lessonId/materials", async (req, res) => {
  const { Title, MaterialType, URL, FilePath, FileName, FileSizeBytes } = req.body;
  if (!Title || !MaterialType)
    return res.status(400).json({ error: "Title and MaterialType are required." });

  try {
    const p = await getPool();
    const r = await p.request()
      .input("courseId",      sql.Int,      +req.params.courseId)
      .input("lessonId",      sql.Int,      +req.params.lessonId)
      .input("title",         sql.NVarChar, Title)
      .input("materialType",  sql.NVarChar, MaterialType)
      .input("url",           sql.NVarChar, URL || null)
      .input("filePath",      sql.NVarChar, FilePath || null)
      .input("fileName",      sql.NVarChar, FileName || null)
      .input("fileSizeBytes", sql.BigInt,   FileSizeBytes || null)
      .query(`
        INSERT INTO [dbo].[CourseLessonMaterial]
          (CourseID, LessonId, Title, MaterialType, URL, FilePath, FileName, FileSizeBytes, CreatedAt, UpdatedAt)
        OUTPUT INSERTED.MaterialId, INSERTED.CourseID, INSERTED.LessonId,
               INSERTED.Title, INSERTED.MaterialType, INSERTED.URL,
               INSERTED.FilePath, INSERTED.FileName, INSERTED.FileSizeBytes,
               INSERTED.CreatedAt, INSERTED.UpdatedAt
        VALUES (@courseId, @lessonId, @title, @materialType, @url, @filePath, @fileName, @fileSizeBytes,
                SYSUTCDATETIME(), SYSUTCDATETIME())
      `);
    res.status(201).json(r.recordset[0]);
  } catch (err) {
    console.error("POST material:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* DELETE /api/materials/:id */
app.delete("/api/materials/:id", async (req, res) => {
  try {
    const p = await getPool();
    const r = await p.request()
      .input("id", sql.Int, +req.params.id)
      .query("DELETE FROM [dbo].[CourseLessonMaterial] WHERE MaterialId = @id");
    if (!r.rowsAffected[0]) return res.status(404).json({ error: "Material not found" });
    res.json({ success: true, deletedId: +req.params.id });
  } catch (err) {
    console.error("DELETE material:", err.message);
    res.status(500).json({ error: err.message });
  }
});


/* ════════════════════════════════════════════════════════════════
   AUTH ROUTES  –  Login · Forgot Password · Reset Password
════════════════════════════════════════════════════════════════ */

/* POST /api/login */
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: "Email and password are required." });
  try {
    const bcrypt = require("bcrypt");
    const p = await getPool();
    const result = await p.request()
      .input("email", sql.NVarChar, email.trim())
      .query(`
        SELECT userId, email, passwordHash, role, firstName, lastName, isActive
        FROM   [dbo].[User]
        WHERE  email = @email
      `);
    const user = result.recordset[0];
    if (!user)
      return res.status(401).json({ error: "Invalid email or password." });
    if (!user.isActive)
      return res.status(403).json({ error: "This account is disabled. Contact your instructor." });
    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match)
      return res.status(401).json({ error: "Invalid email or password." });
    res.json({
      userId:    user.userId,
      email:     user.email,
      firstName: user.firstName,
      lastName:  user.lastName,
      role:      user.role,
      isActive:  user.isActive
    });
  } catch (err) {
    console.error("POST /api/login:", err.message);
    res.status(500).json({ error: "Server error. Please try again." });
  }
});

/* POST /api/forgot-password
   Accepts : { email }
   Action  : Generates a secure token, stores it in-memory for 1 hour,
             and emails a reset link to the user's .edu address.
   Response: Always 200 — never reveals whether the email exists. */
app.post("/api/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email)
    return res.status(400).json({ error: "Email is required." });

  try {
    const p = await getPool();
    const result = await p.request()
      .input("email", sql.NVarChar, email.trim().toLowerCase())
      .query(`
        SELECT userId, email, firstName, isActive
        FROM   [dbo].[User]
        WHERE  LOWER(email) = @email
      `);

    const user = result.recordset[0];

    // Return success regardless — prevents user enumeration
    if (!user || !user.isActive) {
      return res.json({ message: "If that email exists, a reset link has been sent." });
    }

    // Invalidate any existing token for this user
    for (const [t, data] of resetTokens.entries()) {
      if (data.userId === user.userId) resetTokens.delete(t);
    }

    // Generate a cryptographically secure 64-char hex token
    const token   = crypto.randomBytes(32).toString("hex");
    const expires = Date.now() + 60 * 60 * 1000; // 1 hour
    resetTokens.set(token, { userId: user.userId, email: user.email, expires });

    const resetUrl = `https://melendja.github.io/WebII_CoursesDemo/login.html?token=${token}`;

    await emailTransport.sendMail({
      from:    `"${process.env.EMAIL_FROM || "Web Systems II LMS"}" <${process.env.EMAIL_USER}>`,
      to:      user.email,
      subject: "Web Systems II \u2014 Password Reset Request",
      html: `
        <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">
          <div style="background:#1a2d4a;padding:20px 24px;border-bottom:3px solid #e8a020">
            <h2 style="color:#fff;margin:0;font-size:18px">Web Systems II LMS</h2>
            <p style="color:#a8bcce;margin:4px 0 0;font-size:12px">521F_SP26_ON &nbsp;&middot;&nbsp; Daytona State College</p>
          </div>
          <div style="padding:24px;background:#fff;border:1px solid #e5e7eb">
            <p>Hi <strong>${user.firstName}</strong>,</p>
            <p style="color:#374151">
              A password reset was requested for your LMS account.
              Click below to set a new password. This link expires in <strong>1 hour</strong>.
            </p>
            <a href="${resetUrl}"
               style="display:inline-block;background:#1a2d4a;color:#fff;
                      padding:12px 28px;border-radius:6px;text-decoration:none;
                      font-weight:bold;font-size:14px">
              Reset My Password &rarr;
            </a>
            <p style="margin-top:20px;font-size:12px;color:#6b7280">
              If you did not request this, ignore this email &mdash; your password will not change.<br>
              Expires: ${new Date(expires).toLocaleString("en-US", { timeZone: "America/New_York" })} ET
            </p>
          </div>
        </div>
      `
    });

    console.log(`Password reset email sent to ${user.email}`);
    res.json({ message: "If that email exists, a reset link has been sent." });

  } catch (err) {
    console.error("POST /api/forgot-password:", err.message);
    res.status(500).json({ error: "Failed to send reset email. Please try again." });
  }
});

/* POST /api/reset-password
   Accepts : { token, newPassword }
   Action  : Verifies the token, bcrypt-hashes the new password,
             and writes it to dbo.User.passwordHash.
   The User table schema is NOT changed — only the hash value is updated. */
app.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword)
    return res.status(400).json({ error: "Token and new password are required." });

  if (newPassword.length < 8)
    return res.status(400).json({ error: "Password must be at least 8 characters." });

  const entry = resetTokens.get(token);
  if (!entry)
    return res.status(400).json({ error: "Invalid or expired reset link. Please request a new one." });

  if (Date.now() > entry.expires) {
    resetTokens.delete(token);
    return res.status(400).json({ error: "This reset link has expired. Please request a new one." });
  }

  try {
    const bcrypt  = require("bcrypt");
    const newHash = await bcrypt.hash(newPassword, 12);

    const p = await getPool();
    await p.request()
      .input("hash",   sql.NVarChar, newHash)
      .input("userId", sql.Int,      entry.userId)
      .query("UPDATE [dbo].[User] SET passwordHash = @hash WHERE userId = @userId");

    resetTokens.delete(token); // single-use — invalidate immediately
    console.log(`Password reset successful for userId ${entry.userId}`);
    res.json({ message: "Password updated successfully. You can now log in." });

  } catch (err) {
    console.error("POST /api/reset-password:", err.message);
    res.status(500).json({ error: "Failed to update password. Please try again." });
  }
});

/* ════════════════════════════════════════════════════════════════
   HEALTH CHECK
════════════════════════════════════════════════════════════════ */
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
  console.log(`   Health    : http://localhost:${PORT}/api/health`);
  console.log(`   Users     : http://localhost:${PORT}/api/users`);
  console.log(`   Courses   : http://localhost:${PORT}/api/courses`);
  console.log(`   Lessons   : http://localhost:${PORT}/api/courses/:id/lessons`);
  console.log(`   Materials : http://localhost:${PORT}/api/courses/:id/materials\n`);
  console.log(`   Login     : http://localhost:${PORT}/api/login`);
  console.log(`   Forgot Pw : http://localhost:${PORT}/api/forgot-password`);
  console.log(`   Reset Pw  : http://localhost:${PORT}/api/reset-password`);
  getPool().catch(err => console.error("❌ DB connection failed:", err.message));
});
