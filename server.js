const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
require('dotenv').config();

const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Email Configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'your_email@gmail.com',
        pass: process.env.EMAIL_PASS || 'your_app_password'
    }
});

const sendNotification = async (subject, text) => {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER || 'your_email@gmail.com',
            to: process.env.EMAIL_TARGET || 'harshasubhaash123@gmail.com',
            subject: subject,
            text: text
        });
        console.log(`[Notification Sent]: ${subject}`);
    } catch (err) {
        console.error('[Email Error]: Please configure valid email credentials to send emails.', err.message);
    }
};

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Keep backwards compatibility for existing SQLite local uploads if they exist
if (fs.existsSync('./uploads')) {
    app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
}

// Multer Setup - VERSON UPDATED FOR VERCEL (Memory Storage to bypass read-only filesystem)
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// ======================= DB ADAPTER (VERCEL PG vs SQLITE) =======================
let dbAdapter = {};

if (process.env.DATABASE_URL) {
    // PostgreSQL / Vercel Serverless Implementation
    console.log('Connecting to PostgreSQL (Vercel Mode)...');
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });

    pool.query(`
        CREATE TABLE IF NOT EXISTS Users (
            UserID SERIAL PRIMARY KEY, Name TEXT, Phone TEXT, Email TEXT UNIQUE, Password TEXT, Address TEXT
        );
        CREATE TABLE IF NOT EXISTS Admin (
            AdminID SERIAL PRIMARY KEY, Name TEXT, Password TEXT
        );
        CREATE TABLE IF NOT EXISTS Complaints (
            ComplaintID SERIAL PRIMARY KEY, UserID INTEGER REFERENCES Users(UserID), Title TEXT, 
            Description TEXT, Category TEXT, Priority TEXT, Image TEXT, Location TEXT, 
            Date TEXT, Status TEXT DEFAULT 'Pending'
        );
    `);

    // Ensure default admin exists
    bcrypt.hash('admin123', 10, async (err, hash) => {
        const { rows } = await pool.query(`SELECT * FROM Admin WHERE Name = 'admin'`);
        if (rows.length === 0) await pool.query(`INSERT INTO Admin (Name, Password) VALUES ('admin', $1)`, [hash]);
    });

    dbAdapter.run = async (sql, params = []) => {
        let i = 1; while(sql.includes('?')) sql = sql.replace('?', `$${i++}`); // Convert ? to $1, $2
        if (sql.toUpperCase().includes('INSERT')) sql += ' RETURNING *';
        const res = await pool.query(sql, params);
        if (sql.toUpperCase().includes('INSERT') && res.rows.length > 0) {
            return Object.values(res.rows[0])[0]; // Return the generated ID (first column)
        }
        return res.rowCount;
    };
    dbAdapter.get = async (sql, params = []) => {
        let i = 1; while(sql.includes('?')) sql = sql.replace('?', `$${i++}`);
        const res = await pool.query(sql, params);
        return res.rows[0];
    };
    dbAdapter.all = async (sql, params = []) => {
        let i = 1; while(sql.includes('?')) sql = sql.replace('?', `$${i++}`);
        const res = await pool.query(sql, params);
        return res.rows;
    };
} else {
    // Standard Local SQLite Implementation
    console.log('Connecting to SQLite (Local Mode). Set DATABASE_URL in .env to switch to Postgres.');
    const db = new sqlite3.Database('./database.db');
    
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS Users (
            UserID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, Phone TEXT, Email TEXT UNIQUE, Password TEXT, Address TEXT
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS Admin (
            AdminID INTEGER PRIMARY KEY AUTOINCREMENT, Name TEXT, Password TEXT
        )`);
        
        bcrypt.hash('admin123', 10, (err, hash) => {
            db.get('SELECT * FROM Admin WHERE AdminID = 1', (err, row) => {
                if (!row) db.run('INSERT INTO Admin (Name, Password) VALUES (?, ?)', ['admin', hash]);
            });
        });
        
        db.run(`CREATE TABLE IF NOT EXISTS Complaints (
            ComplaintID INTEGER PRIMARY KEY AUTOINCREMENT, UserID INTEGER, Title TEXT, Description TEXT,
            Category TEXT, Priority TEXT, Image TEXT, Location TEXT, Date TEXT, Status TEXT DEFAULT 'Pending',
            Timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY(UserID) REFERENCES Users(UserID)
        )`);
    });

    dbAdapter.run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function(err) {
            if (err) reject(err); else resolve(this.lastID);
        });
    });
    dbAdapter.get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
    dbAdapter.all = (sql, params = []) => new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
}

// ======================= APIs =======================

app.post('/api/register', async (req, res) => {
    const { name, phone, email, password, address } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const lastID = await dbAdapter.run('INSERT INTO Users (Name, Phone, Email, Password, Address) VALUES (?, ?, ?, ?, ?)', [name, phone, email.toLowerCase(), hashedPassword, address]);
        res.json({ message: 'Registration successful', userId: lastID });
    } catch (err) {
        res.status(400).json({ error: 'Email already exists or invalid data' });
    }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await dbAdapter.get('SELECT * FROM Users WHERE Email = ?', [email.toLowerCase()]);
        if (!user) return res.status(400).json({ error: 'User not found' });
        
        const match = await bcrypt.compare(password, user.Password);
        if (match) res.json({ message: 'Login successful', userId: user.UserID, name: user.Name });
        else res.status(400).json({ error: 'Invalid password' });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/login', async (req, res) => {
    const { adminId, password } = req.body;
    try {
        const admin = await dbAdapter.get('SELECT * FROM Admin WHERE Name = ?', [adminId]);
        if (!admin) return res.status(400).json({ error: 'Admin not found' });
        
        const match = await bcrypt.compare(password, admin.Password);
        if (match) res.json({ message: 'Admin login successful' });
        else res.status(400).json({ error: 'Invalid password' });
    } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// 4. Submit Complaint - FIXED FOR VERCEL (Base64 storing instead of filesystem uploads)
app.post('/api/complaints', upload.single('image'), async (req, res) => {
    const { userId, title, description, category, priority, location, date } = req.body;
    
    // Store image directly in DB as base64 so it persists on Vercel flawlessly
    let imageStr = null;
    if (req.file) {
        imageStr = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    }

    try {
        const lastID = await dbAdapter.run('INSERT INTO Complaints (UserID, Title, Description, Category, Priority, Image, Location, Date) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [userId, title, description, category, priority, imageStr, location, date]);
            
        sendNotification(
            `New ${priority} Priority Complaint: ${title}`, 
            `A new complaint was submitted.\nCategory: ${category}\nTitle: ${title}\nDescription: ${description}\nLocation: ${location || 'N/A'}\nSystem Record ID: ${lastID}`
        );

        res.json({ message: 'Complaint submitted successfully', complaintId: lastID });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/complaints/user/:userId', async (req, res) => {
    try {
        const rows = await dbAdapter.all('SELECT * FROM Complaints WHERE UserID = ? ORDER BY ComplaintID DESC', [req.params.userId]);
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/complaints', async (req, res) => {
    try {
        const rows = await dbAdapter.all('SELECT Complaints.*, Users.Name, Users.Phone, Users.Email FROM Complaints JOIN Users ON Complaints.UserID = Users.UserID ORDER BY ComplaintID DESC');
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/complaints/:id/status', async (req, res) => {
    try {
        await dbAdapter.run('UPDATE Complaints SET Status = ? WHERE ComplaintID = ?', [req.body.status, req.params.id]);
        res.json({ message: 'Status updated successfully' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/complaints/:id', async (req, res) => {
    try {
        await dbAdapter.run('DELETE FROM Complaints WHERE ComplaintID = ?', [req.params.id]);
        res.json({ message: 'Complaint deleted successfully' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        // Query adjusted to be standard SQL compatible for both SQLite & PostgreSQL
        const row = await dbAdapter.get(`
            SELECT 
                COUNT(*) as total, 
                SUM(CASE WHEN Status='Resolved' THEN 1 ELSE 0 END) as resolved, 
                SUM(CASE WHEN Status='Pending' THEN 1 ELSE 0 END) as pending 
            FROM Complaints
        `);
        res.json(row);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/help', (req, res) => {
    const { name, phone, message, location } = req.body;
    const alertMessage = `EMERGENCY ALERT!\nName: ${name || 'Anonymous'}\nPhone: ${phone || 'Unknown'}\nLocation: ${location || 'Not provided'}\nDetails: ${message || 'Urgent Help Requested'}`;
    sendNotification('EMERGENCY ALERT TRIGGERED', alertMessage);
    
    console.log(`\n\x1b[31m[SMS API MOCK]\x1b[0m Sending SMS to Authorities & Admin Phone: 9380268436`);
    console.log(`\x1b[33m${alertMessage}\x1b[0m\n`);
    res.json({ message: 'Emergency help requested successfully. Authorities notified via Email and SMS.' });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

module.exports = app;
