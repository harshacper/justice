const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'justiceline_secure_jwt_2026';
const IS_PROD = !!process.env.DATABASE_URL;

// ======================== TWILIO SMS CONFIG ========================
const TWILIO_SID     = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_MSG_SID = process.env.TWILIO_MESSAGING_SERVICE_SID || 'MG4a7e8fa0990192a7e174084246981ae6';
const ADMIN_PHONE    = process.env.ADMIN_PHONE || '+919380268436';

const sendSMS = async (body, to = ADMIN_PHONE) => {
    if (!TWILIO_SID || !TWILIO_TOKEN) { console.log('[SMS] Skipped – no Twilio credentials'); return; }
    try {
        const twilio = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
        await twilio.messages.create({ body, messagingServiceSid: TWILIO_MSG_SID, to });
        console.log('[SMS Sent]:', body.substring(0, 60));
    } catch (err) { console.error('[SMS Error]:', err.message); }
};

// ======================== EMAIL CONFIG ========================
const sendEmail = async (subject, text, to = null) => {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) { console.log('[Email] Skipped – no credentials'); return; }
    try {
        const transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: to || process.env.EMAIL_TARGET || 'harshasubhaash123@gmail.com',
            subject, text
        });
        console.log('[Email Sent]:', subject);
    } catch (err) { console.error('[Email Error]:', err.message); }
};

// Unified alert: sends both SMS + Email
const sendAlert = async (subject, body, userEmail = null) => {
    await Promise.allSettled([
        sendEmail(subject, body, userEmail),
        !userEmail ? sendSMS(body.substring(0, 300)) : Promise.resolve()
    ]);
};

// ======================== MIDDLEWARE ========================
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'] }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ======================== AUTH ========================
const authMiddleware = (req, res, next) => {
    const token = req.headers['authorization']?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized. Please login.' });
    try { req.user = jwt.verify(token, JWT_SECRET); next(); }
    catch { res.status(401).json({ error: 'Session expired. Please login again.' }); }
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

// ======================== DATABASE ========================
let db = {};

async function initPostgres() {
    const { Pool } = require('pg');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
        max: 10,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000
    });
    await pool.query('SELECT 1'); // test connection
    console.log('[DB] PostgreSQL connected ✅');

    // Create tables individually (pg does NOT support multiple statements in one query)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Users (
            UserID     SERIAL PRIMARY KEY,
            Name       TEXT NOT NULL,
            Phone      TEXT,
            Email      TEXT UNIQUE NOT NULL,
            Password   TEXT NOT NULL,
            Address    TEXT,
            CreatedAt  TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Admin (
            AdminID  SERIAL PRIMARY KEY,
            Name     TEXT UNIQUE NOT NULL,
            Password TEXT NOT NULL,
            Role     TEXT DEFAULT 'admin'
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Complaints (
            ComplaintID  SERIAL PRIMARY KEY,
            UserID       INTEGER REFERENCES Users(UserID) ON DELETE SET NULL,
            Title        TEXT NOT NULL,
            Description  TEXT,
            Category     TEXT,
            Priority     TEXT DEFAULT 'Medium',
            Image        TEXT,
            Location     TEXT,
            Date         TEXT,
            Status       TEXT DEFAULT 'Pending',
            Department   TEXT DEFAULT 'General',
            AdminResponse TEXT,
            AssignedTo   TEXT,
            IsEmergency  BOOLEAN DEFAULT FALSE,
            Timestamp    TIMESTAMP DEFAULT NOW()
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS ActivityLogs (
            LogID     SERIAL PRIMARY KEY,
            Action    TEXT,
            UserID    INTEGER,
            Details   TEXT,
            Timestamp TIMESTAMP DEFAULT NOW()
        )
    `);

    // Seed admin accounts
    for (const [name, pass] of [['harsha123','harsha1432'],['admin','admin123']]) {
        const { rows } = await pool.query('SELECT AdminID FROM Admin WHERE Name=$1', [name]);
        if (!rows.length) {
            const hashed = await bcrypt.hash(pass, 10);
            await pool.query('INSERT INTO Admin (Name,Password) VALUES ($1,$2)', [name, hashed]);
            console.log(`[DB] Admin "${name}" created`);
        }
    }

    // Build adapter (converts ? → $1,$2...)
    const q2p = (sql, params = []) => {
        let i = 1; sql = sql.replace(/\?/g, () => `$${i++}`);
        return pool.query(sql, params);
    };
    db.run = async (sql, params = []) => {
        const isIns = /^\s*INSERT/i.test(sql);
        const r = await q2p(isIns ? sql.replace(/;?\s*$/, ' RETURNING *') : sql, params);
        if (isIns && r.rows.length) return Object.values(r.rows[0])[0];
        return r.rowCount;
    };
    db.get  = async (sql, p = []) => { const r = await q2p(sql, p); return r.rows[0]; };
    db.all  = async (sql, p = []) => { const r = await q2p(sql, p); return r.rows; };
}

async function initSQLite() {
    const sqlite3 = require('sqlite3').verbose();
    const sqlDb = new sqlite3.Database('./database.db');
    await new Promise((res) => sqlDb.serialize(() => {
        sqlDb.run(`CREATE TABLE IF NOT EXISTS Users (UserID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, Phone TEXT, Email TEXT UNIQUE, Password TEXT, Address TEXT, CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        sqlDb.run(`CREATE TABLE IF NOT EXISTS Admin (AdminID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT UNIQUE, Password TEXT, Role TEXT DEFAULT 'admin')`);
        sqlDb.run(`CREATE TABLE IF NOT EXISTS Complaints (ComplaintID INTEGER PRIMARY KEY AUTOINCREMENT, UserID INTEGER, Title TEXT, Description TEXT, Category TEXT, Priority TEXT DEFAULT 'Medium', Image TEXT, Location TEXT, Date TEXT, Status TEXT DEFAULT 'Pending', Department TEXT DEFAULT 'General', AdminResponse TEXT, AssignedTo TEXT, IsEmergency INTEGER DEFAULT 0, Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(UserID) REFERENCES Users(UserID))`);
        sqlDb.run(`CREATE TABLE IF NOT EXISTS ActivityLogs (LogID INTEGER PRIMARY KEY AUTOINCREMENT, Action TEXT, UserID INTEGER, Details TEXT, Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        ['Department TEXT DEFAULT "General"','AdminResponse TEXT','AssignedTo TEXT','IsEmergency INTEGER DEFAULT 0'].forEach(c => sqlDb.run(`ALTER TABLE Complaints ADD COLUMN ${c}`, () => {}));
        res();
    }));
    for (const [name, pass] of [['harsha123','harsha1432'],['admin','admin123']]) {
        await new Promise(res => sqlDb.get('SELECT AdminID FROM Admin WHERE Name=?', [name], async (_,row) => {
            if (!row) { const h = await bcrypt.hash(pass,10); sqlDb.run('INSERT INTO Admin (Name,Password) VALUES (?,?)', [name,h], () => { console.log(`[DB] Admin "${name}" created`); res(); }); }
            else res();
        }));
    }
    db.run = (s,p=[]) => new Promise((res,rej) => sqlDb.run(s,p,function(e){e?rej(e):res(this.lastID)}));
    db.get = (s,p=[]) => new Promise((res,rej) => sqlDb.get(s,p,(e,r)=>e?rej(e):res(r)));
    db.all = (s,p=[]) => new Promise((res,rej) => sqlDb.all(s,p,(e,r)=>e?rej(e):res(r||[])));
}

const logActivity = async (action, userId, details) => {
    try { await db.run('INSERT INTO ActivityLogs (Action,UserID,Details) VALUES (?,?,?)', [action, userId, details]); }
    catch { /* non-critical */ }
};

// ======================== USER ROUTES ========================
app.post('/api/register', async (req, res) => {
    const { name, phone, email, password, address } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        const id = await db.run('INSERT INTO Users (Name,Phone,Email,Password,Address) VALUES (?,?,?,?,?)',
            [name.trim(), phone||'', email.toLowerCase().trim(), hashed, address||'']);
        await logActivity('REGISTER', id, `New user: ${email}`);
        // Welcome SMS to admin
        sendSMS(`🆕 New user registered on JusticeLine!\nName: ${name}\nEmail: ${email}\nPhone: ${phone||'N/A'}`);
        res.json({ message: 'Registration successful! Please login.' });
    } catch(err) {
        if (/UNIQUE|unique/i.test(err.message)) return res.status(400).json({ error: 'Email already registered.' });
        console.error('[Register]', err.message);
        res.status(500).json({ error: 'Server error. Please try again.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    try {
        const user = await db.get('SELECT * FROM Users WHERE Email=?', [email.toLowerCase().trim()]);
        if (!user) return res.status(400).json({ error: 'No account found with this email.' });
        if (!await bcrypt.compare(password, user.Password)) return res.status(400).json({ error: 'Incorrect password.' });
        const token = jwt.sign({ userId: user.UserID, name: user.Name, email: user.Email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
        await logActivity('LOGIN', user.UserID, `Login: ${email}`);
        res.json({ message: 'Login successful!', token, userId: user.UserID, name: user.Name, role: 'user' });
    } catch(err) {
        console.error('[Login]', err.message);
        res.status(500).json({ error: 'Server error.' });
    }
});

// ======================== COMPLAINT ROUTES ========================
app.post('/api/complaints', authMiddleware, upload.single('image'), async (req, res) => {
    const { title, description, category, priority, location, date, isEmergency } = req.body;
    const userId = req.user.userId;
    let imageStr = null;
    if (req.file) imageStr = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const emergency = isEmergency === 'true' || priority === 'Emergency';
    try {
        const id = await db.run(
            'INSERT INTO Complaints (UserID,Title,Description,Category,Priority,Image,Location,Date,IsEmergency) VALUES (?,?,?,?,?,?,?,?,?)',
            [userId, title, description, category, priority||'Medium', imageStr, location, date, IS_PROD ? emergency : (emergency?1:0)]
        );
        await logActivity('COMPLAINT', userId, `#${id}: ${title} [${priority}]`);
        const msg = `${emergency?'🚨 EMERGENCY!\n':'📋 New Complaint Filed!\n'}ID: #${String(id).padStart(4,'0')}\nTitle: ${title}\nCategory: ${category}\nPriority: ${priority}\nLocation: ${location||'N/A'}\nBy User #${userId}`;
        await sendAlert(emergency ? `🚨 EMERGENCY: ${title}` : `New Complaint: ${title}`, msg);
        res.json({ message: 'Complaint submitted successfully.', complaintId: id });
    } catch(err) {
        console.error('[Complaint]', err.message);
        res.status(500).json({ error: 'Failed to submit. Please try again.' });
    }
});

app.get('/api/complaints/user', authMiddleware, async (req, res) => {
    try { res.json(await db.all('SELECT * FROM Complaints WHERE UserID=? ORDER BY ComplaintID DESC', [req.user.userId]) || []); }
    catch(err) { res.status(500).json({ error: err.message }); }
});

// ======================== ADMIN ROUTES ========================
app.post('/api/admin/login', async (req, res) => {
    const { adminId, password } = req.body;
    if (!adminId || !password) return res.status(400).json({ error: 'Username and password required.' });
    try {
        const admin = await db.get('SELECT * FROM Admin WHERE Name=?', [adminId.trim()]);
        if (!admin) return res.status(400).json({ error: 'Admin account not found.' });
        if (!await bcrypt.compare(password, admin.Password)) return res.status(400).json({ error: 'Incorrect password.' });
        const token = jwt.sign({ adminId: admin.AdminID, name: admin.Name, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        await logActivity('ADMIN_LOGIN', admin.AdminID, `Admin: ${adminId}`);
        res.json({ message: 'Login successful.', token, name: admin.Name, role: 'admin' });
    } catch(err) {
        console.error('[AdminLogin]', err.message);
        res.status(500).json({ error: 'Server error.' });
    }
});

app.get('/api/admin/complaints', adminMiddleware, async (req, res) => {
    try {
        const { status, priority, category, search } = req.query;
        let sql = 'SELECT c.*,u.Name as UserName,u.Phone,u.Email FROM Complaints c LEFT JOIN Users u ON c.UserID=u.UserID WHERE 1=1';
        const p = [];
        if (status)   { sql += ' AND c.Status=?';        p.push(status); }
        if (priority) { sql += ' AND c.Priority=?';      p.push(priority); }
        if (category) { sql += ' AND c.Category=?';      p.push(category); }
        if (search)   { sql += ' AND (c.Title LIKE ? OR c.Description LIKE ?)'; p.push(`%${search}%`, `%${search}%`); }
        sql += ' ORDER BY c.IsEmergency DESC, c.ComplaintID DESC';
        res.json(await db.all(sql, p) || []);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        const eCond = IS_PROD ? 'IsEmergency=TRUE' : 'IsEmergency=1';
        const row = await db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN Status='Resolved' THEN 1 ELSE 0 END) as resolved, SUM(CASE WHEN Status='Pending' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN Status='In Progress' THEN 1 ELSE 0 END) as inprogress, SUM(CASE WHEN ${eCond} THEN 1 ELSE 0 END) as emergencies FROM Complaints`);
        const users = await db.get('SELECT COUNT(*) as total FROM Users');
        res.json({ ...row, users: users?.total || 0 });
    } catch(err) { res.json({ total:0, resolved:0, pending:0, inprogress:0, emergencies:0, users:0 }); }
});

app.put('/api/admin/complaints/:id/status', adminMiddleware, async (req, res) => {
    const { status, department, assignedTo } = req.body;
    try {
        const comp = await db.get('SELECT * FROM Complaints WHERE ComplaintID=?', [req.params.id]);
        await db.run('UPDATE Complaints SET Status=?,Department=COALESCE(?,Department),AssignedTo=COALESCE(?,AssignedTo) WHERE ComplaintID=?',
            [status, department||null, assignedTo||null, req.params.id]);
        await logActivity('STATUS_UPDATE', req.user.adminId, `#${req.params.id} → ${status}`);
        // SMS admin on status change
        sendSMS(`📊 Complaint #${String(req.params.id).padStart(4,'0')} updated\nNew Status: ${status}\nTitle: ${comp?.Title||'Unknown'}\nDept: ${department||'—'}`);
        res.json({ message: 'Updated.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/complaints/:id/respond', adminMiddleware, async (req, res) => {
    const { response } = req.body;
    try {
        const comp = await db.get('SELECT * FROM Complaints WHERE ComplaintID=?', [req.params.id]);
        await db.run('UPDATE Complaints SET AdminResponse=? WHERE ComplaintID=?', [response, req.params.id]);
        await logActivity('RESPONSE', req.user.adminId, `Response to #${req.params.id}`);
        if (comp) {
            const user = await db.get('SELECT Email,Phone FROM Users WHERE UserID=?', [comp.UserID]);
            if (user?.Email) sendEmail(`Update on your complaint: ${comp.Title}`, `Official Update:\n\n"${response}"\n\nStatus: ${comp.Status}`, user.Email);
            if (user?.Phone) sendSMS(`✅ JusticeLine Update\nYour complaint "${comp.Title}" received a response:\n"${response.substring(0,100)}"\nStatus: ${comp.Status}`, user.Phone.startsWith('+') ? user.Phone : `+91${user.Phone.replace(/\D/g,'')}`);
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
    try { res.json(await db.all('SELECT UserID,Name,Phone,Email,Address,CreatedAt FROM Users ORDER BY UserID DESC') || []); }
    catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/activity', adminMiddleware, async (req, res) => {
    try { res.json(await db.all('SELECT * FROM ActivityLogs ORDER BY LogID DESC LIMIT 100') || []); }
    catch(err) { res.status(500).json({ error: err.message }); }
});

// ======================== SOS ROUTE ========================
app.post('/api/help', async (req, res) => {
    const { name, phone, message, location } = req.body;
    const txt = `🚨 EMERGENCY SOS TRIGGERED!\nName: ${name||'Anonymous'}\nPhone: ${phone||'N/A'}\nLocation: ${location||'Unknown'}\nMessage: ${message||'Urgent help needed!'}`;
    await Promise.allSettled([
        sendEmail('🚨 EMERGENCY SOS', txt),
        sendSMS(txt.substring(0, 320))
    ]);
    await logActivity('SOS', null, `SOS from ${name||'Anonymous'}`);
    res.json({ message: 'Emergency alert sent to authorities via Email & SMS.' });
});

// ======================== HEALTH CHECK ========================
app.get('/health', (_req, res) => res.json({ status:'ok', mode: IS_PROD?'postgresql':'sqlite', time: new Date().toISOString() }));

// ======================== STARTUP ========================
async function startServer() {
    try {
        console.log(`[DB] Mode: ${IS_PROD ? 'PostgreSQL (Production)' : 'SQLite (Local)'}`);
        if (IS_PROD) await initPostgres();
        else await initSQLite();
        app.listen(PORT, () => console.log(`✅ JusticeLine running → http://localhost:${PORT}`));
    } catch (err) {
        console.error('❌ Startup failed:', err.message);
        process.exit(1);
    }
}

startServer();
module.exports = app;
