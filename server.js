const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'justiceline_secure_jwt_secret_2026';

// ======================= MIDDLEWARE =======================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
if (fs.existsSync('./uploads')) app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

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

if (process.env.DATABASE_URL) {
    console.log('Connecting to PostgreSQL...');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

    pool.query(`
        CREATE TABLE IF NOT EXISTS Users (UserID SERIAL PRIMARY KEY, Name TEXT, Phone TEXT, Email TEXT UNIQUE, Password TEXT, Address TEXT, CreatedAt TIMESTAMP DEFAULT NOW());
        CREATE TABLE IF NOT EXISTS Admin (AdminID SERIAL PRIMARY KEY, Name TEXT, Password TEXT, Role TEXT DEFAULT 'admin');
        CREATE TABLE IF NOT EXISTS Complaints (
            ComplaintID SERIAL PRIMARY KEY, UserID INTEGER REFERENCES Users(UserID), Title TEXT,
            Description TEXT, Category TEXT, Priority TEXT, Image TEXT, Location TEXT,
            Date TEXT, Status TEXT DEFAULT 'Pending', Department TEXT DEFAULT 'General',
            AdminResponse TEXT, AssignedTo TEXT, IsEmergency BOOLEAN DEFAULT FALSE,
            Timestamp TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS ActivityLogs (
            LogID SERIAL PRIMARY KEY, Action TEXT, UserID INTEGER, Details TEXT, Timestamp TIMESTAMP DEFAULT NOW()
        );
    `).then(async () => {
        // Setup admins
        const hash1 = await bcrypt.hash('admin123', 10);
        const hash2 = await bcrypt.hash('harsha1432', 10);
        const r1 = await pool.query(`SELECT * FROM Admin WHERE Name='admin'`);
        if (!r1.rows.length) await pool.query(`INSERT INTO Admin (Name,Password) VALUES ('admin',$1)`, [hash1]);
        const r2 = await pool.query(`SELECT * FROM Admin WHERE Name='harsha123'`);
        if (!r2.rows.length) await pool.query(`INSERT INTO Admin (Name,Password) VALUES ('harsha123',$1)`, [hash2]);
    });

    const q2p = (sql, params = []) => {
        let i = 1; sql = sql.replace(/\?/g, () => `$${i++}`);
        return pool.query(sql, params);
    };
    db.run = async (sql, params = []) => {
        const isInsert = sql.toUpperCase().includes('INSERT');
        if (isInsert) sql += ' RETURNING *';
        const res = await q2p(sql, params);
        return isInsert && res.rows.length ? Object.values(res.rows[0])[0] : res.rowCount;
    };
    db.get = async (sql, params = []) => { const res = await q2p(sql, params); return res.rows[0]; };
    db.all = async (sql, params = []) => { const res = await q2p(sql, params); return res.rows; };

} else {
    console.log('Connecting to SQLite (Local Mode)...');
    const sqliteDb = new sqlite3.Database('./database.db');
    sqliteDb.serialize(() => {
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS Users (UserID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, Phone TEXT, Email TEXT UNIQUE, Password TEXT, Address TEXT, CreatedAt DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS Admin (AdminID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, Password TEXT, Role TEXT DEFAULT 'admin')`);
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS Complaints (
            ComplaintID INTEGER PRIMARY KEY AUTOINCREMENT, UserID INTEGER, Title TEXT, Description TEXT,
            Category TEXT, Priority TEXT, Image TEXT, Location TEXT, Date TEXT, Status TEXT DEFAULT 'Pending',
            Department TEXT DEFAULT 'General', AdminResponse TEXT, AssignedTo TEXT, IsEmergency INTEGER DEFAULT 0,
            Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(UserID) REFERENCES Users(UserID))`);
        sqliteDb.run(`CREATE TABLE IF NOT EXISTS ActivityLogs (LogID INTEGER PRIMARY KEY AUTOINCREMENT, Action TEXT, UserID INTEGER, Details TEXT, Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);

        bcrypt.hash('admin123', 10, (_, h1) => {
            sqliteDb.get(`SELECT * FROM Admin WHERE Name='admin'`, (_, r) => {
                if (!r) sqliteDb.run(`INSERT INTO Admin (Name,Password) VALUES ('admin',?)`, [h1]);
            });
        });
        bcrypt.hash('harsha1432', 10, (_, h2) => {
            sqliteDb.get(`SELECT * FROM Admin WHERE Name='harsha123'`, (_, r) => {
                if (!r) sqliteDb.run(`INSERT INTO Admin (Name,Password) VALUES ('harsha123',?)`, [h2]);
            });
        });

        // Add new columns if they don't exist (migration)
        ['Department TEXT DEFAULT "General"','AdminResponse TEXT','AssignedTo TEXT','IsEmergency INTEGER DEFAULT 0'].forEach(col => {
            sqliteDb.run(`ALTER TABLE Complaints ADD COLUMN ${col}`, () => {});
        });
    });

    db.run = (sql, params = []) => new Promise((res, rej) => sqliteDb.run(sql, params, function(err) { err ? rej(err) : res(this.lastID); }));
    db.get = (sql, params = []) => new Promise((res, rej) => sqliteDb.get(sql, params, (err, row) => err ? rej(err) : res(row)));
    db.all = (sql, params = []) => new Promise((res, rej) => sqliteDb.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));
}

const logActivity = async (action, userId, details) => {
    try { await db.run('INSERT INTO ActivityLogs (Action, UserID, Details) VALUES (?,?,?)', [action, userId, details]); }
    catch(e) { console.error('Log error:', e.message); }
};

// ======================= USER APIs =======================
app.post('/api/register', async (req, res) => {
    const { name, phone, email, password, address } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    try {
        const hashed = await bcrypt.hash(password, 10);
        const id = await db.run('INSERT INTO Users (Name, Phone, Email, Password, Address) VALUES (?,?,?,?,?)', [name, phone, email.toLowerCase(), hashed, address]);
        await logActivity('REGISTER', id, `New user registered: ${email}`);
        res.json({ message: 'Registration successful! Please login.' });
    } catch { res.status(400).json({ error: 'Email already registered.' }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await db.get('SELECT * FROM Users WHERE Email = ?', [email.toLowerCase()]);
        if (!user) return res.status(400).json({ error: 'No account found with this email.' });
        const match = await bcrypt.compare(password, user.Password);
        if (!match) return res.status(400).json({ error: 'Incorrect password.' });
        const token = jwt.sign({ userId: user.UserID, name: user.Name, email: user.Email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
        await logActivity('LOGIN', user.UserID, `User logged in: ${email}`);
        res.json({ message: 'Login successful!', token, userId: user.UserID, name: user.Name, role: 'user' });
    } catch(err) { res.status(500).json({ error: 'Server error.' }); }
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
            [userId, title, description, category, priority || 'Medium', imageStr, location, date, emergency ? 1 : 0]
        );
        await logActivity('COMPLAINT_SUBMIT', userId, `Complaint #${id}: ${title} [${priority}]`);
        const notifText = `${emergency ? '🚨 EMERGENCY ALERT!\n' : ''}New Complaint: ${title}\nCategory: ${category}\nPriority: ${priority}\nLocation: ${location || 'N/A'}\nDescription: ${description}\nSubmitted by User #${userId}`;
        sendNotification(emergency ? `🚨 EMERGENCY Complaint: ${title}` : `New Complaint: ${title}`, notifText);
        res.json({ message: 'Complaint submitted successfully.', complaintId: id });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/complaints/user', authMiddleware, async (req, res) => {
    try {
        const rows = await db.all('SELECT * FROM Complaints WHERE UserID = ? ORDER BY ComplaintID DESC', [req.user.userId]);
        res.json(rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ======================= ADMIN APIs =======================
app.post('/api/admin/login', async (req, res) => {
    const { adminId, password } = req.body;
    try {
        const admin = await db.get('SELECT * FROM Admin WHERE Name = ?', [adminId]);
        if (!admin) return res.status(400).json({ error: 'Admin account not found.' });
        const match = await bcrypt.compare(password, admin.Password);
        if (!match) return res.status(400).json({ error: 'Incorrect admin password.' });
        const token = jwt.sign({ adminId: admin.AdminID, name: admin.Name, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
        await logActivity('ADMIN_LOGIN', admin.AdminID, `Admin logged in: ${adminId}`);
        res.json({ message: 'Admin login successful.', token, name: admin.Name, role: 'admin' });
    } catch(err) { res.status(500).json({ error: 'Server error.' }); }
});

app.get('/api/admin/complaints', adminMiddleware, async (req, res) => {
    try {
        const { status, priority, category, search } = req.query;
        let sql = 'SELECT c.*, u.Name as UserName, u.Phone, u.Email FROM Complaints c LEFT JOIN Users u ON c.UserID = u.UserID WHERE 1=1';
        const params = [];
        if (status) { sql += ' AND c.Status = ?'; params.push(status); }
        if (priority) { sql += ' AND c.Priority = ?'; params.push(priority); }
        if (category) { sql += ' AND c.Category = ?'; params.push(category); }
        if (search) { sql += ' AND (c.Title LIKE ? OR c.Description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
        sql += ' ORDER BY c.IsEmergency DESC, c.ComplaintID DESC';
        const rows = await db.all(sql, params);
        res.json(rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
    try {
        const row = await db.get(`SELECT COUNT(*) as total, SUM(CASE WHEN Status='Resolved' THEN 1 ELSE 0 END) as resolved, SUM(CASE WHEN Status='Pending' THEN 1 ELSE 0 END) as pending, SUM(CASE WHEN Status='In Progress' THEN 1 ELSE 0 END) as inprogress, SUM(CASE WHEN IsEmergency=1 OR IsEmergency=TRUE THEN 1 ELSE 0 END) as emergencies FROM Complaints`);
        const users = await db.get('SELECT COUNT(*) as total FROM Users');
        res.json({ ...row, users: users?.total || 0 });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/complaints/:id/status', adminMiddleware, async (req, res) => {
    const { status, department, assignedTo } = req.body;
    try {
        await db.run('UPDATE Complaints SET Status=?, Department=COALESCE(?,Department), AssignedTo=COALESCE(?,AssignedTo) WHERE ComplaintID=?', [status, department, assignedTo, req.params.id]);
        await logActivity('STATUS_UPDATE', req.user.adminId, `Complaint #${req.params.id} → ${status}`);
        res.json({ message: 'Updated successfully.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/complaints/:id/respond', adminMiddleware, async (req, res) => {
    const { response } = req.body;
    try {
        const comp = await db.get('SELECT * FROM Complaints WHERE ComplaintID=?', [req.params.id]);
        await db.run('UPDATE Complaints SET AdminResponse=? WHERE ComplaintID=?', [response, req.params.id]);
        await logActivity('ADMIN_RESPONSE', req.user.adminId, `Response to Complaint #${req.params.id}`);
        // Notify user if we have their email
        if (comp) {
            const user = await db.get('SELECT Email FROM Users WHERE UserID=?', [comp.UserID]);
            if (user?.Email) {
                sendNotification(`Update on your complaint: ${comp.Title}`, `Your complaint has received an official update:\n\n"${response}"\n\nCurrent Status: ${comp.Status}`, user.Email);
            }
        }
        res.json({ message: 'Response sent.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/complaints/:id', adminMiddleware, async (req, res) => {
    try {
        await db.run('DELETE FROM Complaints WHERE ComplaintID=?', [req.params.id]);
        await logActivity('DELETE', req.user.adminId, `Deleted complaint #${req.params.id}`);
        res.json({ message: 'Complaint removed.' });
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
    try {
        const rows = await db.all('SELECT UserID, Name, Phone, Email, Address, CreatedAt FROM Users ORDER BY UserID DESC');
        res.json(rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/activity', adminMiddleware, async (req, res) => {
    try {
        const rows = await db.all('SELECT * FROM ActivityLogs ORDER BY LogID DESC LIMIT 100');
        res.json(rows);
    } catch(err) { res.status(500).json({ error: err.message }); }
});

// ======================= SOS / HELP =======================
app.post('/api/help', async (req, res) => {
    const { name, phone, message, location } = req.body;
    const alert = `🚨 EMERGENCY SOS!\nName: ${name||'Anonymous'}\nPhone: ${phone||'Unknown'}\nLocation: ${location||'Not provided'}\nDetails: ${message||'Urgent help needed!'}`;
    sendNotification('🚨 EMERGENCY SOS TRIGGERED', alert);
    await logActivity('SOS', null, `SOS from ${name||'Anonymous'} at ${location}`);
    res.json({ message: 'Emergency alert sent to authorities.' });
});

app.listen(PORT, () => console.log(`✅ JusticeLine running on http://localhost:${PORT}`));
module.exports = app;
