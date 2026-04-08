const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');

const app = express();

// ==========================================
// Fix #5: CORS WHITELIST — bukan wildcard *
// ==========================================
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5665,http://192.168.1.3:5665').split(',');

const corsMiddleware = cors({
  origin: (origin, callback) => {
    // Izinkan request tanpa origin (server-to-server, curl, Postman saat dev)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('CORS: Origin tidak diizinkan'));
  },
  credentials: true,
});

// CORS hanya diterapkan ke /api routes — bukan ke /admin (EJS server-side)

// ==========================================
// Middleware dasar
// ==========================================
app.use(cookieParser());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Konfigurasi EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// ==========================================
// Fix #4: RATE LIMITING
// ==========================================

// Login: maks 5 percobaan per 5 menit per IP
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak percobaan login. Coba lagi dalam 5 menit.'
  }
});

// Aktivasi: maks 10 percobaan per 10 menit per IP
const activationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak percobaan aktivasi. Coba lagi dalam 10 menit.'
  }
});

// Registrasi: maks 3 akun per jam per IP
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak akun dibuat dari IP ini. Coba lagi dalam 1 jam.'
  }
});

// Rate limit AI — maks 5 analisis per 10 menit per IP
const aiLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Terlalu banyak permintaan analisis. Coba lagi dalam 10 menit.'
  }
});

// Fix: CORS harus diletakkan SEBELUM rate limiter agar response 429 tetap mendapat header CORS
app.use('/api', corsMiddleware);

// Terapkan rate limit ke endpoint spesifik
app.use('/api/login', loginLimiter);
app.use('/api/activate', activationLimiter);
app.use('/api/consignors', registerLimiter);
app.use('/api/ai', aiLimiter);

// ==========================================
// Fix #3: PROTEKSI ROUTE /admin dengan session cookie
// ==========================================
const ADMIN_SESSION_NAME = 'jitu_admin_sess';
const ADMIN_SESSION_VALUE = 'authenticated';

// Middleware cek cookie admin
function requireAdminSession(req, res, next) {
  const sess = req.cookies?.[ADMIN_SESSION_NAME];
  if (sess === ADMIN_SESSION_VALUE) return next();
  return res.redirect('/admin/login');
}

// Halaman login admin (GET)
app.get('/admin/login', (req, res) => {
  const sess = req.cookies?.[ADMIN_SESSION_NAME];
  if (sess === ADMIN_SESSION_VALUE) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

// Proses login admin (POST)
app.post('/admin/login', (req, res) => {
  const { secret_key } = req.body;
  const validSecret = process.env.ADMIN_SECRET_KEY;

  if (!validSecret) {
    console.error('[SECURITY] ADMIN_SECRET_KEY tidak di-set!');
    return res.render('admin/login', { error: 'Konfigurasi server bermasalah.' });
  }

  if (secret_key !== validSecret) {
    return res.render('admin/login', { error: 'Secret Key tidak valid.' });
  }

  // Set cookie session (httpOnly agar tidak bisa dibaca JS browser)
  res.cookie(ADMIN_SESSION_NAME, ADMIN_SESSION_VALUE, {
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 4 * 60 * 60 * 1000, // 4 jam
  });

  return res.redirect('/admin');
});

// Logout admin
app.get('/admin/logout', (req, res) => {
  res.clearCookie(ADMIN_SESSION_NAME);
  res.redirect('/admin/login');
});

// Panel admin — diproteksi middleware
app.get('/admin', requireAdminSession, (req, res) => {
  res.render('admin/index');
});

// ==========================================
// API Routes
// ==========================================
const consignorRoutes = require('./routes/Consignors');
const syncRoutes = require("./routes/Sync");
const activationRoutes = require("./routes/Activation");
const aiRoutes = require("./routes/AI");

// Fix #5: CORS hanya untuk API routes (frontend Next.js) - sudah dipanggil secara global di atas rate limit
app.use('/api', consignorRoutes);
app.use('/api', syncRoutes);
app.use('/api', activationRoutes);
app.use('/api', aiRoutes);

// ==========================================
// Error Handler Global
// ==========================================
app.use((err, req, res, next) => {
  // Fix #6: Sembunyikan detail error dari client
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({
      success: false,
      message: "Payload terlalu besar. Maksimum 10MB per request.",
    });
  }
  if (err && err.message === 'CORS: Origin tidak diizinkan') {
    return res.status(403).json({ success: false, message: 'Akses tidak diizinkan.' });
  }
  console.error('[GLOBAL ERROR]', err.message);
  return res.status(500).json({ success: false, message: 'Terjadi kesalahan server.' });
});

module.exports = app;
