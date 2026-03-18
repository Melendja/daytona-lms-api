# Daytona LMS — Local API Setup

## Requirements
- Node.js 18+ (https://nodejs.org)
- SQL Server 17 running locally (`localhost\Melendja\chief`)
- ODBC Driver 17 for SQL Server installed
  → Download: https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server

---

## 1. Install dependencies

Open a terminal inside the `api/` folder and run:

```bash
npm install
npm install bcrypt          # for password hashing (matches your $2b$12$ hashes)
npm install msnodesqlv8     # for Windows Authentication
```

---

## 2. Configure the connection

Edit `.env` if your instance name or DB name differs:

```
DB_SERVER=localhost\Melendja\chief
DB_DATABASE=daytona_lms
DB_TRUSTED=true
PORT=3000
```

If you use **SQL Server Authentication** instead of Windows Auth:
```
DB_TRUSTED=false
DB_USER=sa
DB_PASSWORD=yourpassword
```

---

## 3. Start the API

```bash
npm start
# or for auto-reload during development:
npm run dev
```

You should see:
```
✅ Connected to SQL Server (Windows Auth / ODBC)
🚀 Daytona LMS API running at http://localhost:3000
```

Verify it works by opening: http://localhost:3000/api/health

---

## 4. Open the frontend

Open `login.html` in your browser (via VS Code Live Server or directly).

**Credentials:**
- Username: `Admin`
- Password: `521F`

---

## API Endpoints

| Method | URL | Description |
|--------|-----|-------------|
| GET | /api/health | DB connection check |
| GET | /api/users | All users |
| GET | /api/users/:id | Single user |
| POST | /api/users | Create user |
| PUT | /api/users/:id | Update user |
| DELETE | /api/users/:id | Delete user |
| GET | /api/courses | All courses |
| GET | /api/courses/:id | Single course |

---

## File Structure

```
/
├── login.html          ← Login page (entry point)
├── admin-users.html    ← Admin user management
├── courses-workspace-demo.html
└── api/
    ├── server.js       ← Express API
    ├── package.json
    ├── .env            ← DB connection config
    └── README.md
```
