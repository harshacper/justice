const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'justiceline_secure_jwt_secret_2026';
const IS_PROD = !!process.env.DATABASE_URL;

// ======================= MIDDLEWARE =======================
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ======================= AUTH MIDDLEWARE =======================
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized. Please login.' });
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Invalid or expired token. Please login again.' }); }
};

const adminMiddleware = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Admin access required.' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden.' });
        next();
    } catch { res.status(401).json({ error: 'Invalid admin token.' }); }
};

// ======================= EMAIL =======================
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});
const sendNotification = async (subject, text, to = null) => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) { console.log('[Email] Skipped — no credentials'); return; }
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: to || process.env.EMAIL_TARGET || 'harshasubhaash123@gmail.com',
            subject, text
        });
        console.log(`[Email Sent]: ${subject}`);
    } catch (err) { console.error('[Email Error]:', err.message); }
};

// ======================= DB ADAPTER =======================
let db = {};

// ---- PostgreSQL (Production) ----
async function initPostgres() {
    const { Pool } = require('pg');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    // Test connection
    await pool.query('SELECT 1');
    console.log('[DB] PostgreSQL connected');

    // Create tables one by one
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Users (
            UserID SERIAL PRIMARY KEY,
            Name TEXT NOT NULL,
            Phone TEXT,
            Email TEXT UNIQUE NOT NULL,
            Password TEXT NOT NULL,
            Address TEXT,
            CreatedAt TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Admin (
            AdminID SERIAL PRIMARY KEY,
            Name TEXT UNIQUE NOT NULL,
            Password TEXT NOT NULL,
            Role TEXT DEFAULT 'admin'
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Complaints (
            ComplaintID SERIAL PRIMARY KEY,
            UserID INTEGER REFERENCES Users(UserID) ON DELETE CASCADE,
            Title TEXT NOT NULL,
            Description TEXT,
            Category TEXT,
            Priority TEXT DEFAULT 'Medium',
            Image TEXT,
            Location TEXT,
            Date TEXT,
            Status TEXT DEFAULT 'Pending',
            Department TEXT DEFAULT 'General',
            AdminResponse TEXT,
            AssignedTo TEXT,
            IsEmergency BOOLEAN DEFAULT FALSE,
            Timestamp TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ActivityLogs (
            LogID SERIAL PRIMARY KEY,
            Action TEXT,
            UserID INTEGER,
            Details TEXT,
            Timestamp TIMESTAMP DEFAULT NOW()
        )
    `);

    // Seed admin accounts
    const adminAccounts = [
        { name: 'harsha123', pass: 'harsha1432' },
        { name: 'admin', pass: 'admin123' }
    ];
    for (const acc of adminAccounts) {
        const existing = await pool.query('SELECT AdminID FROM Admin WHERE Name=$1', [acc.name]);
        if (!existing.rows.length) {
            const hashed = await bcrypt.hash(acc.pass, 10);
            await pool.query('INSERT INTO Admin (Name,Password) VALUES ($1,$2)', [acc.name, hashed]);
            console.log(`[DB] Admin "${acc.name}" created`);
        }
    }

    // DB adapter (convert ? to $1,$2 for pg)
    const q2p = (sql, params = []) => {
        let i = 1; sql = sql.replace(/\?/g, () => `$${i++}`);
        return pool.query(sql, params);
    };
    db.run = async (sql, params = []) => {
        const isInsert = /^\s*INSERT/i.test(sql);
        const pgSql = isInsert ? sql.replace(/;?\s*$/, ' RETURNING *') : sql;
        const res = await q2p(pgSql, params);
        if (isInsert && res.rows.length) return Object.values(res.rows[0])[0];
        return res.rowCount;
    };
    db.get = async (sql, params = []) => { const r = await q2p(sql, params); return r.rows[0]; };
    db.all = async (sql, params = []) => { const r = await q2p(sql, params); return r.rows; };
    db.isReady = true;
    return pool;
}

// ---- SQLite (Development) ----
async function initSQLite() {
    const sqlite3 = require('sqlite3').verbose();
    const sqliteDb = new sqlite3.Database('./database.db');
    await new Promise((res, rej) => sqliteDb.serialize(() => {
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS Users (
            UserID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, Phone TEXT,
            Email TEXT UNIQUE, Password TEXT, Address TEXT,
            CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS Admin (
            AdminID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE,
            Password TEXT, Role TEXT DEFAULT 'admin'
        )`);
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS Complaints (
            ComplaintID INTEGER PRIMARY KEY AUTOINCREMENT, UserID INTEGER,
            Title TEXT, Description TEXT, Category TEXT, Priority TEXT DEFAULT 'Medium',
            Image TEXT, Location TEXT, Date TEXT, Status TEXT DEFAULT 'Pending',
            Department TEXT DEFAULT 'General', AdminResponse TEXT, AssignedTo TEXT,
            IsEmergency INTEGER DEFAULT 0, Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(UserID) REFERENCES Users(UserID)
        )`);
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS ActivityLogs (
            LogID INTEGER PRIMARY KEY AUTOINCREMENT, Action TEXT, UserID INTEGER,
            Details TEXT, Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        // Migration: add columns if they don't exist
        ['Department TEXT DEFAULT "General"','AdminResponse TEXT','AssignedTo TEXT','IsEmergency INTEGER DEFAULT 0'].forEach(col => {
            sqliteDb.run(`ALTER TABLE Complaints ADD COLUMN ${col}`, () => {});
        });
        res();
    }));

    // Seed admin accounts
    const adminAccounts = [
        { name: 'harsha123', pass: 'harsha1432' },
        { name: 'admin', pass: 'admin123' }
    ];
    for (const acc of adminAccounts) {
        await new Promise(res => {
            sqliteDb.get('SELECT AdminID FROM Admin WHERE Name=?', [acc.name], async (err, row) => {
                if (!row) {
                    const hashed = await bcrypt.hash(acc.pass, 10);
                    sqliteDb.run('INSERT INTO Admin (Name,Password) VALUES (?,?)', [acc.name, hashed], () => {
                        console.log(`[DB] Admin "${acc.name}" created`); res();
                    });
                } else res();
            });
        });
    }

    db.run = (sql, params = []) => new Promise((res, rej) => sqliteDb.run(sql, params, function(e) { e ? rej(e) : res(this.lastID); }));
    db.get = (sql, params = []) => new Promise((res, rej) => sqliteDb.get(sql, params, (e, row) => e ? rej(e) : res(row)));
    db.all = (sql, params = []) => new Promise((res, rej) => sqliteDb.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));
    db.isReady = true;
    return sqliteDb;
}

const logActivity = async (action, userId, details) => {
    try { await db.run('INSERT INTO ActivityLogs (Action,UserID,Details) VALUES (?,?,?)', [action, userId, details]); }
    catch(e) { /* non-critical */ }
};

// ======================= USER APIs =======================
app.post('/api/register', async (req, res) => {
    const { name, phone, email, password, address } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        const id = await db.run('INSERT INTO Users (Name,Phone,Email,Password,Address) VALUES (?,?,?,?,?)',
            [name.trim(), phone||'', email.toLowerCase().trim(), hashed, address||'']);
        await logActivity('REGISTER', id, `New user: ${email}`);
        res.json({ message: 'Registration successful! Please login.' });
    } catch(err) {
        if (err.message?.includes('UNIQUE') || err.message?.includes('unique')) {
            return res.status(400).json({ error: 'Email already registered. Please login instead.' });
        }
        console.error('[Register Error]:', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
    try {
        const user = await db.get('SELECT * FROM Users WHERE Email=?', [email.toLowerCase().trim()]);
        if (!user) return res.status(400).json({ error: 'No account found with this email.' });
        const match = await bcrypt.compare(password, user.Password);
        if (!match) return res.status(400).json({ error: 'Incorrect password.' });
        const token = jwt.sign(
            { userId: user.UserID, name: user.Name, email: user.Email, role: 'user' },
            JWT_SECRET, { expiresIn: '7d' }
        );
        await logActivity('LOGIN', user.UserID, `User login: ${email}`);
        res.json({ message: 'Login successful!', token, userId: user.UserID, name: user.Name, role: 'user' });
    } catch(err) {
        console.error('[Login Error]:', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

// ======================= COMPLAINT APIs =======================
app.post('/api/complaints', authMiddleware, upload.single('image'), async (req, res) => {
    const { title, description, category, priority, location, date, isEmergency } = req.body;
    const userId = req.user.userId;
    let imageStr = null;
    if (req.file) imageStr = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const emergency = isEmergency === 'true' || isEmergency === true || priority === 'Emergency';
    try {
        const id = await db.run(
            'INSERT INTO Complaints (UserID,Title,Description,Category,Priority,Image,Location,Date,IsEmergency) VALUES (?,?,?,?,?,?,?,?,?)',
            [userId, title, description, category, priority||'Medium', imageStr, location, date, IS_PROD ? emergency : (emergency ? 1 : 0)]
        );
        await logActivity('COMPLAINT_SUBMIT', userId, `Complaint #${id}: ${title} [${priority}]`);
        const notifText = `${emergency ? '🚨 EMERGENCY ALERT!\n' : ''}New Complaint: ${title}\nCategory: ${category}\nPriority: ${priority}\nLocation: ${location||'N/A'}\nDescription: ${description}\nUser ID: ${userId}`;
        sendNotification(emergency ? `🚨 EMERGENCY: ${title}` : `New Complaint: ${title}`, notifText);
        res.json({ message: 'Complaint submitted successfully.', complaintId: id });
    } catch(err) {
        console.error('[Complaint Error]:', err.message);
        res.status(500).json({ error: 'Failed to submit complaint. Please try again.' });
    }
});

app.get('/api/complaints/user', authMiddleware, async (req, res) => {
    try {
        const rows = await db.all('SELECT * FROM Complaints WHERE UserID=? ORDER BY ComplaintID DESC', [req.user.userId]);
        res.json(rows || []);
    } catch(err) {
        console.error('[Complaints Error]:', err.message);
        res.status(500).json({ error: 'Failed to load complaints.' });
    }
});

// ======================= ADMIN APIs =======================
app.post('/api/admin/login', async (req, res) => {
    const { adminId, password } = req.body;
    if (!adminId || !password) return res.status(400).json({ error: 'Username and password required.' });
    try {
        const admin = await db.get('SELECT * FROM Admin WHERE Name=?', [adminId.trim()]);
        if (!admin) return res.status(400).json({ error: 'Admin account not found.' });
        const match = await bcrypt.compare(password, admin.Password);
        if (!match) return res.status(400).json({ error: 'Incorrect password.' });
        const token = jwt.sign(
            { adminId: admin.AdminID, name: admin.Name, role: 'admin' },
            JWT_SECRET, { expiresIn: '24h' }
        );
        await logActivity('ADMIN_LOGIN', admin.AdminID, `Admin login: ${adminId}`);
        res.json({ message: 'Admin login successful.', token, name: admin.Name, role: 'admin' });
    } catch(err) {
        console.error('[Admin Login Error]:', err.message);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/api/admin/complaints', adminMiddleware, async (req, res) => {
    try {
        const { status, priority, category, search } = req.query;
        let sql = 'SELECT c.*, u.Name as UserName, u.Phone, u.Email FROM Complaints c LEFT JOIN Users u ON c.UserID=u.UserID WHERE 1=1';
        const params = [];
        if (status) { sql += ' AND c.Status=?'; params.push(status); }
        if (priority) { sql += ' AND c.Priority=?'; params.push(priority); }
        if (category) { sql += ' AND c.Category=?'; params.push(category); }
        if (search) { sql += ' AND (c.Title LIKE ? OR c.Description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
        sql += ' ORDER BY c.IsEmergency DESC, c.ComplaintID DESC';
        const rows = await db.all(sql, params);
        res.json(rows || []);
    } catch(err) {
        console.error('[Admin Complaints Error]:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        let row, users;
        if (IS_PROD) {
            row = await db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN Status='Resolved' THEN 1 ELSE 0 END) as resolved, SUM(CASE WHEN Status='Pending' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN Status='In Progress' THEN 1 ELSE 0 END) as inprogress, SUM(CASE WHEN IsEmergency=TRUE THEN 1 ELSE 0 END) as emergencies FROM Complaints`);
        } else {
            row = await db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN Status='Resolved' THEN 1 ELSE 0 END) as resolved, SUM(CASE WHEN Status='Pending' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN Status='In Progress' THEN 1 ELSE 0 END) as inprogress, SUM(CASE WHEN IsEmergency=1 THEN 1 ELSE 0 END) as emergencies FROM Complaints`);
        }
        users = await db.get('SELECT COUNT(*) as total FROM Users');
        res.json({ ...row, users: users?.total || 0 });
    } catch(err) {
        console.error('[Stats Error]:', err.message);
        res.json({ total:0, resolved:0, pending:0, inprogress:0, emergencies:0, users:0 });
    }
});

app.put('/api/admin/complaints/:id/status', adminMiddleware, async (req, res) => {
    const { status, department, assignedTo } = req.body;
    try {
        await db.run('UPDATE Complaints SET Status=?,Department=COALESCE(?,Department),AssignedTo=COALESCE(?,AssignedTo) WHERE ComplaintID=?',
            [status, department||null, assignedTo||null, req.params.id]);
        await logActivity('STATUS_UPDATE', req.user.adminId, `Complaint #${req.params.id} → ${status}`);
        res.json({ message: 'Updated successfully.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/complaints/:id/respond', adminMiddleware, async (req, res) => {
    const { response } = req.body;
    try {
        const comp = await db.get('SELECT * FROM Complaints WHERE ComplaintID=?', [req.params.id]);
        await db.run('UPDATE Complaints SET AdminResponse=? WHERE ComplaintID=?', [response, req.params.id]);
        await logActivity('ADMIN_RESPONSE', req.user.adminId, `Response to #${req.params.id}`);
        if (comp) {
            const user = await db.get('SELECT Email FROM Users WHERE UserID=?', [comp.UserID]);
            if (user?.Email) sendNotification(`Update on: ${comp.Title}`, `Your complaint has an official update:\n\n"${response}"\n\nStatus: ${comp.Status}`, user.Email);
        }
        res.json({ message: 'Response sent.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/complaints/:id', adminMiddleware, async (req, res) => {
    try {
        await db.run('DELETE FROM Complaints WHERE ComplaintID=?', [req.params.id]);
        await logActivity('DELETE', req.user.adminId, `Deleted #${req.params.id}`);
        res.json({ message: 'Removed.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const rows = await db.all('SELECT UserID,Name,Phone,Email,Address,CreatedAt FROM Users ORDER BY UserID DESC');
        res.json(rows || []);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/activity', adminMiddleware, async (req, res) => {
    try {
        const rows = await db.all('SELECT * FROM ActivityLogs ORDER BY LogID DESC LIMIT 100');
        res.json(rows || []);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ======================= SOS/HELP =======================
app.post('/api/help', async (req, res) => {
    const { name, phone, message, location } = req.body;
    const alert = `🚨 EMERGENCY SOS!\nName: ${name||'Anonymous'}\nPhone: ${phone||'N/A'}\nLocation: ${location||'Not provided'}\nDetails: ${message||'Urgent help needed!'}`;
    sendNotification('🚨 EMERGENCY SOS TRIGGERED', alert);
    await logActivity('SOS', null, `SOS from ${name||'Anonymous'} at ${location||'unknown'}`);
    res.json({ message: 'Emergency alert sent to authorities.' });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', db: IS_PROD ? 'postgresql' : 'sqlite', time: new Date().toISOString() }));

// ======================= STARTUP =======================
async function startServer() {
    try {
        console.log(`[DB] Mode: ${IS_PROD ? 'PostgreSQL (Production)' : 'SQLite (Local)'}`);
        if (IS_PROD) {
            await initPostgres();
        } else {
            await initSQLite();
        }
        app.listen(PORT, () => {
            console.log(`✅ JusticeLine running on http://localhost:${PORT}`);
            console.log(`[DB] Database initialized and ready`);
        });
    } catch (err) {
        console.error('❌ Startup failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

startServer();
module.exports = app;
