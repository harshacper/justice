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
    if (!TWILIO_SID || !TWILIO_TOKEN) {
        console.log('[SMS] Skipped – add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env');
        return { success: false, reason: 'No Twilio credentials configured' };
    }
    try {
        const twilio = require('twilio')(TWILIO_SID, TWILIO_TOKEN);
        const msg = await twilio.messages.create({
            body: body.substring(0, 1600),
            messagingServiceSid: TWILIO_MSG_SID,
            to
        });
        console.log(`[SMS ✅ Sent] SID: ${msg.sid} → ${to}: ${body.substring(0, 50)}...`);
        return { success: true, sid: msg.sid };
    } catch (err) {
        console.error('[SMS ❌ Error]:', err.message);
        return { success: false, reason: err.message };
    }
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
            MLCategory   TEXT,
            MLPriority   TEXT,
            MLSentiment  TEXT,
            MLConfidence INTEGER DEFAULT 0,
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
    await pool.query(`
        CREATE TABLE IF NOT EXISTS LoginHistory (
            LoginID   SERIAL PRIMARY KEY,
            UserID    INTEGER,
            Email     TEXT,
            Role      TEXT DEFAULT 'user',
            IPAddress TEXT,
            UserAgent TEXT,
            LoginAt   TIMESTAMP DEFAULT NOW()
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
        sqlDb.run(`CREATE TABLE IF NOT EXISTS Complaints (ComplaintID INTEGER PRIMARY KEY AUTOINCREMENT, UserID INTEGER, Title TEXT, Description TEXT, Category TEXT, Priority TEXT DEFAULT 'Medium', Image TEXT, Location TEXT, Date TEXT, Status TEXT DEFAULT 'Pending', Department TEXT DEFAULT 'General', AdminResponse TEXT, AssignedTo TEXT, IsEmergency INTEGER DEFAULT 0, MLCategory TEXT, MLPriority TEXT, MLSentiment TEXT, MLConfidence INTEGER DEFAULT 0, Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(UserID) REFERENCES Users(UserID))`);
        sqlDb.run(`CREATE TABLE IF NOT EXISTS ActivityLogs (LogID INTEGER PRIMARY KEY AUTOINCREMENT, Action TEXT, UserID INTEGER, Details TEXT, Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        sqlDb.run(`CREATE TABLE IF NOT EXISTS LoginHistory (LoginID INTEGER PRIMARY KEY AUTOINCREMENT, UserID INTEGER, Email TEXT, Role TEXT DEFAULT 'user', IPAddress TEXT, UserAgent TEXT, LoginAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        // Migration: add columns if missing
        ['Department TEXT DEFAULT "General"','AdminResponse TEXT','AssignedTo TEXT','IsEmergency INTEGER DEFAULT 0','MLCategory TEXT','MLPriority TEXT','MLSentiment TEXT','MLConfidence INTEGER DEFAULT 0'].forEach(c => sqlDb.run(`ALTER TABLE Complaints ADD COLUMN ${c}`, () => {}));
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
        // Log full session info
        const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'Unknown';
        const ua = req.headers['user-agent'] || 'Unknown';
        await logActivity('LOGIN', user.UserID, `Login: ${email} from ${ip}`);
        await db.run('INSERT INTO LoginHistory (UserID,Email,Role,IPAddress,UserAgent) VALUES (?,?,?,?,?)',
            [user.UserID, email.toLowerCase().trim(), 'user', ip, ua]).catch(()=>{});
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
    try { res.json(await db.all('SELECT * FROM ActivityLogs ORDER BY LogID DESC LIMIT 200') || []); }
    catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Full complaint detail (single) ──
app.get('/api/admin/complaints/:id', adminMiddleware, async (req, res) => {
    try {
        const c = await db.get(`SELECT c.*, u.Name as UserName, u.Phone as UserPhone, u.Email as UserEmail, u.Address as UserAddress, u.CreatedAt as UserJoined FROM Complaints c LEFT JOIN Users u ON c.UserID=u.UserID WHERE c.ComplaintID=?`, [req.params.id]);
        if (!c) return res.status(404).json({ error: 'Complaint not found.' });
        // Get activity for this complaint
        const logs = await db.all(`SELECT * FROM ActivityLogs WHERE Details LIKE ? ORDER BY Timestamp ASC LIMIT 20`, [`%#${req.params.id}%`]);
        // Complaint count for same user
        const userStats = c.UserID ? await db.get('SELECT COUNT(*) as total FROM Complaints WHERE UserID=?', [c.UserID]) : null;
        res.json({ ...c, activityLogs: logs, userComplaintCount: userStats?.total || 0 });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Users list with complaint counts & last login ──
app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const users = await db.all('SELECT UserID,Name,Phone,Email,Address,CreatedAt FROM Users ORDER BY UserID DESC') || [];
        // Attach complaint count + last login for each user
        const enriched = await Promise.all(users.map(async u => {
            const stats = await db.get('SELECT COUNT(*) as total, SUM(CASE WHEN Status=\'Resolved\' THEN 1 ELSE 0 END) as resolved FROM Complaints WHERE UserID=?', [u.UserID || u.userid]);
            const lastLogin = await db.get('SELECT LoginAt,IPAddress,UserAgent FROM LoginHistory WHERE UserID=? ORDER BY LoginAt DESC LIMIT 1', [u.UserID || u.userid]).catch(()=>null);
            return { ...u, totalComplaints: stats?.total||0, resolvedComplaints: stats?.resolved||0, lastLogin: lastLogin?.LoginAt||null, lastIP: lastLogin?.IPAddress||null, lastUA: lastLogin?.UserAgent||null };
        }));
        res.json(enriched);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── Full user profile (complaints + login history) ──
app.get('/api/admin/users/:id', adminMiddleware, async (req, res) => {
    try {
        const user = await db.get('SELECT UserID,Name,Phone,Email,Address,CreatedAt FROM Users WHERE UserID=?', [req.params.id]);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const complaints = await db.all('SELECT ComplaintID,Title,Category,Priority,Status,Date,Location,Timestamp FROM Complaints WHERE UserID=? ORDER BY ComplaintID DESC', [req.params.id]);
        const logins = await db.all('SELECT LoginID,IPAddress,UserAgent,LoginAt FROM LoginHistory WHERE UserID=? ORDER BY LoginAt DESC LIMIT 50', [req.params.id]).catch(()=>[]);
        res.json({ ...user, complaints, loginHistory: logins, totalComplaints: complaints.length });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── All login history (admin view) ──
app.get('/api/admin/login-history', adminMiddleware, async (req, res) => {
    try {
        const rows = await db.all(`SELECT l.*, u.Name as UserName FROM LoginHistory l LEFT JOIN Users u ON l.UserID=u.UserID ORDER BY l.LoginAt DESC LIMIT 200`).catch(()=>[]);
        res.json(rows || []);
    } catch(err) { res.status(500).json({ error: err.message }); }
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

// ======================== SMS STATUS CHECK ========================
app.get('/api/sms-status', (_req, res) => {
    const configured = !!(TWILIO_SID && TWILIO_TOKEN);
    res.json({
        configured,
        messagingServiceSid: TWILIO_MSG_SID,
        adminPhone: ADMIN_PHONE,
        accountSidSet: !!TWILIO_SID,
        authTokenSet: !!TWILIO_TOKEN,
        message: configured
            ? '✅ Twilio SMS is configured and ready'
            : '⚠️ Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env to enable SMS'
    });
});

// ======================== SEND SMS FROM WEBSITE ========================
app.post('/api/send-sms', async (req, res) => {
    const { message, phone, type } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required.' });

    // Allow sending to admin phone or a user-supplied phone
    const targetPhone = phone || ADMIN_PHONE;
    const prefix = type === 'support'  ? '📨 Support Request'  :
                   type === 'sos'      ? '🚨 EMERGENCY SOS'   :
                   type === 'complaint'? '📋 New Complaint'    : '📱 JusticeLine';

    const fullMsg = `${prefix}\n${message}\n\n— JusticeLine System`;
    const result = await sendSMS(fullMsg, targetPhone);

    if (result?.success) {
        await logActivity('SMS_SENT', null, `SMS to ${targetPhone}: ${type||'general'}`);
        res.json({ success: true, message: `SMS sent successfully to ${targetPhone}`, sid: result.sid });
    } else {
        res.status(200).json({
            success: false,
            message: result?.reason || 'SMS not configured. Add Twilio credentials to .env',
            hint: 'Get Account SID and Auth Token from https://console.twilio.com'
        });
    }
});

// ======================== ML ANALYZE API ========================
// Server-side keyword-based ML (mirrors client ml-engine.js)
const ML_CATS = {
    'Road Accident':['accident','crash','collision','vehicle','car','bike','road','traffic','hit','injured'],
    'Fire Hazard':['fire','burn','flame','smoke','explosion','blaze','arson','gas leak','electric fire'],
    'Medical Emergency':['medical','hospital','ambulance','heart attack','unconscious','bleeding','seizure','stroke','critical'],
    'Crime in Progress':['crime','robbery','theft','murder','assault','stabbing','kidnap','rape','gang','burglar'],
    'Gas Leak':['gas','lpg','cng','pipe burst','smell','leak','cylinder','methane'],
    'Flood / Natural Disaster':['flood','waterlogging','cyclone','earthquake','landslide','storm','disaster','submerged'],
    'Water Leakage':['water','leak','pipeline','tap','drainage','sewage','burst pipe','no water','contaminated'],
    'Electricity Issue':['electricity','power cut','blackout','transformer','wire','electric','voltage','no power','streetlight'],
    'Garbage Dumping':['garbage','trash','waste','dumping','litter','rubbish','smell','filth','bin'],
    'Road Damage':['pothole','road damage','broken road','crack','uneven','footpath','road repair'],
    'Corruption':['bribe','corruption','extortion','fraud','illegal','embezzlement','scam','money'],
    'Harassment':['harassment','bully','stalk','eve teasing','verbal abuse','domestic violence','abuse'],
    'Noise Pollution':['noise','loud','sound','music','speaker','horn','construction noise','disturbing']
};
const ML_PRIORITY_WORDS = {
    Emergency:['death','dead','dying','murder','explosion','fire','bleeding','unconscious','bomb','critical','urgent','rape','kidnap','heart attack','flood','disaster'],
    High:     ['accident','injury','injured','severe','serious','dangerous','crime','violence','robbery','threat','assault','hospital','ambulance'],
    Low:      ['suggestion','feedback','general','inquiry','information','slow','delay','minor','small','noise']
};
const ML_DEPTS = {'Road Accident':'Traffic & Road Safety','Fire Hazard':'Fire Department','Medical Emergency':'Health & Medical Services','Crime in Progress':'Police Department','Gas Leak':'Gas & Utilities','Flood / Natural Disaster':'Disaster Management','Water Leakage':'Water & Sanitation','Electricity Issue':'Electricity Board','Garbage Dumping':'Municipal / Sanitation','Road Damage':'Public Works Dept','Corruption':'Anti-Corruption Bureau','Harassment':'Police / Women Cell','Noise Pollution':'Environment & Pollution'};

function serverMLAnalyze(text = '', existingCat = '') {
    const lower = text.toLowerCase();
    let bestCat = existingCat || 'Other', bestScore = 0, totalScore = 0;
    Object.entries(ML_CATS).forEach(([cat, kws]) => {
        const s = kws.reduce((acc,kw) => acc + (lower.includes(kw)?1:0), 0);
        totalScore += s;
        if (s > bestScore) { bestScore = s; bestCat = cat; }
    });
    const confidence = bestScore > 0 ? Math.min(97, Math.round((bestScore/(totalScore||1))*100 + 20)) : 30;
    let priority = 'Medium';
    if (ML_PRIORITY_WORDS.Emergency.some(w => lower.includes(w))) priority = 'Emergency';
    else if (ML_PRIORITY_WORDS.High.some(w => lower.includes(w))) priority = 'High';
    else if (ML_PRIORITY_WORDS.Low.some(w => lower.includes(w))) priority = 'Low';
    const posWords = ['good','resolved','fixed','thank','happy','satisfied','working','improved'];
    const negWords = ['angry','worst','terrible','horrible','frustrated','furious','helpless','scared','fear'];
    const posScore = posWords.filter(w=>lower.includes(w)).length;
    const negScore = negWords.filter(w=>lower.includes(w)).length;
    const sentiment = negScore > posScore ? 'Negative' : posScore > negScore ? 'Positive' : 'Neutral';
    return { category: bestCat, priority, sentiment, confidence, department: ML_DEPTS[bestCat]||'General Administration' };
}

app.post('/api/ml/analyze', async (req, res) => {
    const { text, title, category } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required.' });
    const combined = `${title||''} ${text}`;
    const result = serverMLAnalyze(combined, category);
    res.json({ success: true, ...result, analyzedAt: new Date().toISOString() });
});

// ======================== CSV EXPORT ========================
app.get('/api/export/complaints', adminMiddleware, async (req, res) => {
    try {
        const rows = await db.all(`SELECT c.ComplaintID,c.Title,c.Category,c.Priority,c.Status,c.Location,c.Date,c.Department,c.MLCategory,c.MLPriority,c.MLSentiment,c.MLConfidence,c.IsEmergency,c.Timestamp,u.Name as UserName,u.Email,u.Phone FROM Complaints c LEFT JOIN Users u ON c.UserID=u.UserID ORDER BY c.ComplaintID DESC`);
        const headers = ['ID','Title','Category','Priority','Status','Location','Date','Department','ML Category','ML Priority','ML Sentiment','ML Confidence%','Emergency','Timestamp','User Name','Email','Phone'];
        const csv = [headers.join(','), ...rows.map(r => [
            r.ComplaintID||r.complaintid, `"${(r.Title||r.title||'').replace(/"/g,'""')}"`,
            r.Category||r.category, r.Priority||r.priority, r.Status||r.status,
            `"${(r.Location||r.location||'').replace(/"/g,'""')}"`,
            r.Date||r.date, r.Department||r.department,
            r.MLCategory||r.mlcategory||'—', r.MLPriority||r.mlpriority||'—',
            r.MLSentiment||r.mlsentiment||'—', r.MLConfidence||r.mlconfidence||0,
            r.IsEmergency||r.isemergency ? 'YES':'NO',
            r.Timestamp||r.timestamp, r.UserName||r.username,
            r.Email||r.email, r.Phone||r.phone
        ].join(','))].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=justiceline_complaints_${new Date().toISOString().slice(0,10)}.csv`);
        res.send(csv);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ======================== HEALTH CHECK ========================
app.get('/health', (_req, res) => res.json({ status:'ok', mode: IS_PROD?'postgresql':'sqlite', sms: !!(TWILIO_SID && TWILIO_TOKEN), time: new Date().toISOString() }));




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
