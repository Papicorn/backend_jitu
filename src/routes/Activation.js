const express = require('express');
const bcrypt = require('bcrypt');
const { Op } = require('sequelize');
const Consignors = require('../models/Consignors');
const DeviceActivation = require('../models/DeviceActivation');
const PaymentJitu = require('../models/PaymentJitu');

const router = express.Router();

const MAX_DEVICES = 2;
const ACTIVATION_DAYS = 30;

// Helper: cek apakah aktivasi sudah kadaluarsa
function isActivationExpired(activationSetAt) {
  if (!activationSetAt) return true;
  const expiry = new Date(activationSetAt);
  expiry.setDate(expiry.getDate() + ACTIVATION_DAYS);
  return new Date() > expiry;
}

// Middleware proteksi Admin via Secret Key di header
const verifyAdminSecret = (req, res, next) => {
  const secret = req.headers['x-admin-secret'] || req.body.admin_secret;
  const validSecret = process.env.ADMIN_SECRET_KEY;

  if (!validSecret) {
    console.error('[SECURITY] ADMIN_SECRET_KEY tidak di-set!');
    return res.status(500).json({ success: false, message: 'Konfigurasi server tidak lengkap.' });
  }

  if (!secret || secret !== validSecret) {
    return res.status(401).json({
      success: false,
      message: 'Akses ditolak.'
    });
  }
  next();
};

// ==========================================
// ENDPOINT UNTUK USER (UMKM)
// ==========================================

// ENDPOINT UNTUK USER (UMKM) DIBERHENTIKAN
// Endpoint aktivasi user dipindahkan ke proses login di Consignors.js secara internal.
// ==========================================


// ==========================================
// ENDPOINT ADMIN (DIPROTEKSI ADMIN_SECRET)
// ==========================================

// POST /api/admin/set-activation
router.post('/admin/set-activation', verifyAdminSecret, async (req, res) => {
  try {
    const { phone, activation_code } = req.body;

    if (!phone || !activation_code) {
      return res.status(400).json({ success: false, message: 'phone dan activation_code wajib diisi' });
    }

    const consignor = await Consignors.findOne({ where: { phone } });
    if (!consignor) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    // Cek batas penggunaan kode aktivasi yang sama di akun lain (Maks 2 Akun)
    const existingUsers = await Consignors.findAll({ where: { activation: activation_code } });
    const isAlreadyOwner = existingUsers.some(u => u.consignor_id === consignor.consignor_id);
    
    if (!isAlreadyOwner && existingUsers.length >= 2) {
      return res.status(400).json({ success: false, message: 'Kode ini sudah mentok dipakai di 2 akun berbeda. Silakan buat/gunakan kode lain.' });
    }

    // Jika dipasangkan dengan akun lain, ikuti masa expired dari pemilik lain tsb.
    let activationSetAt = new Date();
    if (existingUsers.length > 0) {
      const parentUser = existingUsers.find(u => u.activation_set_at !== null);
      if (parentUser) activationSetAt = parentUser.activation_set_at;
    }

    await Consignors.update(
      { activation: activation_code, activation_set_at: activationSetAt },
      { where: { consignor_id: consignor.consignor_id } }
    );

    return res.json({
      success: true,
      message: `Kode aktivasi berhasil di-set untuk: ${consignor.full_name}`
    });
  } catch (err) {
    console.error('[ADMIN/SET-ACTIVATION] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan.' });
  }
});

// POST /api/admin/user-details
router.post('/admin/user-details', verifyAdminSecret, async (req, res) => {
  try {
    const { searchStr } = req.body;
    if (!searchStr && !req.body.phone) return res.status(400).json({ success: false, message: 'Parameter pencarian wajib diisi' });

    const keyword = searchStr || req.body.phone;

    let consignor = await Consignors.findOne({
      where: { phone: keyword },
      attributes: ['consignor_id', 'full_name', 'email', 'phone', 'activation', 'activation_set_at']
    });

    if (!consignor) {
      consignor = await Consignors.findOne({
        where: { activation: keyword },
        attributes: ['consignor_id', 'full_name', 'email', 'phone', 'activation', 'activation_set_at']
      });
    }

    if (!consignor) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    let sharedGroupIds = [consignor.consignor_id];
    if (consignor.activation) {
      const groupUsers = await Consignors.findAll({ where: { activation: consignor.activation }});
      sharedGroupIds = groupUsers.map(u => u.consignor_id);
    }
    
    const devices = await DeviceActivation.findAll({
      where: { consignor_id: { [Op.in]: sharedGroupIds } }
    });
    let expiresAt = null;
    let isExpired = true;
    if (consignor.activation_set_at) {
      const expiry = new Date(consignor.activation_set_at);
      expiry.setDate(expiry.getDate() + ACTIVATION_DAYS);
      expiresAt = expiry.toISOString();
      isExpired = new Date() > expiry;
    }

    return res.json({
      success: true,
      user: {
        consignor_id: consignor.consignor_id,
        full_name: consignor.full_name,
        phone: consignor.phone,
        has_activation: !!consignor.activation,
        activation_set_at: consignor.activation_set_at,
        expires_at: expiresAt,
        is_expired: isExpired
      },
      devices
    });
  } catch (err) {
    console.error('[ADMIN/USER-DETAILS] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan.' });
  }
});

// DELETE /api/admin/devices/:deviceId
router.delete('/admin/devices/:deviceId', verifyAdminSecret, async (req, res) => {
  try {
    const { deviceId } = req.params;
    const deleted = await DeviceActivation.destroy({ where: { id: deviceId } });

    if (!deleted) return res.status(404).json({ success: false, message: 'Device tidak ditemukan' });

    return res.json({ success: true, message: 'Device berhasil dihapus' });
  } catch (err) {
    console.error('[ADMIN/DELETE-DEVICE] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan.' });
  }
});

// GET /api/admin/payments
router.get('/admin/payments', verifyAdminSecret, async (req, res) => {
  try {
    const ready = await PaymentJitu.findAll({
      where: {
        status: 'success',
        is_processed: 0
      },
      order: [['created_at', 'DESC']]
    });

    const pending = await PaymentJitu.findAll({
      where: {
        status: 'pending'
      },
      order: [['created_at', 'DESC']]
    });

    return res.json({ success: true, payments: { ready, pending } });
  } catch (err) {
    console.error('[ADMIN/GET-PAYMENTS] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan.' });
  }
});

// POST /api/admin/process-payment
router.post('/admin/process-payment', verifyAdminSecret, async (req, res) => {
  try {
    const { id_payment } = req.body;
    if (!id_payment) return res.status(400).json({ success: false, message: 'id_payment wajib diisi' });

    const payment = await PaymentJitu.findOne({ where: { id_payment, status: 'success', is_processed: 0 } });
    if (!payment) return res.status(404).json({ success: false, message: 'Pembayaran tidak ditemukan atau sudah diproses' });

    const phone = payment.whatsapp;
    let consignor = await Consignors.findOne({ where: { phone } });

    // 1. Generate random 6-digit activation code first
    const rawCode = Math.floor(100000 + Math.random() * 900000).toString();

    // 2. Create or find account
    if (!consignor) {
      // Generate email: nama-umkm@jitubisnis.my.id
      const slug = payment.umkm.toLowerCase().replace(/[^a-z0-9]/g, '-');
      const email = `${slug}@jitubisnis.my.id`;
      
      const defaultPassword = 'jitu1234';
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);

      consignor = await Consignors.create({
        full_name: payment.full_name,
        email: email,
        phone: phone,
        password: hashedPassword,
        total_capital: 0,
        last_login: new Date(),
        role: 'Consignor',
        activation: rawCode,
        activation_set_at: new Date() // Mulai hitung 30 hari dari sekarang
      });
    } else {
      // 3. Update activation code if user already exists
      await Consignors.update(
        { activation: rawCode, activation_set_at: new Date() },
        { where: { consignor_id: consignor.consignor_id } }
      );
    }

    // 4. Mark payment as processed
    await payment.update({ is_processed: 1 });

    return res.json({
      success: true,
      message: `Berhasil memproses UMKM: ${payment.umkm}`,
      activation_code: rawCode,
      user: {
        full_name: consignor.full_name,
        phone: consignor.phone,
        email: consignor.email
      }
    });

  } catch (err) {
    console.error('[ADMIN/PROCESS-PAYMENT] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan pemrosesan.' });
  }
});

// GET /api/admin/users
router.get('/admin/users', verifyAdminSecret, async (req, res) => {
  try {
    const users = await Consignors.findAll({
      attributes: ['consignor_id', 'full_name', 'email', 'phone', 'activation', 'activation_set_at', 'last_login'],
      order: [['consignor_id', 'DESC']]
    });

    // Tambah info expiry untuk setiap user
    const usersWithExpiry = users.map(u => {
      const plain = u.toJSON();
      if (plain.activation_set_at) {
        const expiry = new Date(plain.activation_set_at);
        expiry.setDate(expiry.getDate() + ACTIVATION_DAYS);
        plain.expires_at = expiry.toISOString();
        plain.is_expired = new Date() > expiry;
      } else {
        plain.expires_at = null;
        plain.is_expired = true;
      }
      return plain;
    });

    return res.json({ success: true, users: usersWithExpiry });
  } catch (err) {
    console.error('[ADMIN/GET-USERS] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan mengambil data user.' });
  }
});

// POST /api/admin/extend-activation
router.post('/admin/extend-activation', verifyAdminSecret, async (req, res) => {
  try {
    const { phone, days } = req.body;
    const extendDays = parseInt(days) || ACTIVATION_DAYS; // Default 30 hari

    if (!phone) return res.status(400).json({ success: false, message: 'phone wajib diisi' });

    const consignor = await Consignors.findOne({ where: { phone } });
    if (!consignor) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    // Hitung dari tanggal expiry saat ini (jika masih aktif) atau dari sekarang (jika sudah expired)
    let baseDate;
    if (consignor.activation_set_at) {
      const currentExpiry = new Date(consignor.activation_set_at);
      currentExpiry.setDate(currentExpiry.getDate() + ACTIVATION_DAYS);
      baseDate = new Date() > currentExpiry ? new Date() : consignor.activation_set_at;
    } else {
      baseDate = new Date();
    }

    // Perpanjang: geser activation_set_at agar expiry bertambah
    const newSetAt = new Date(baseDate);
    newSetAt.setDate(newSetAt.getDate() + extendDays);
    // Tapi kita simpan sebagai activation_set_at, jadi hitung mundur
    // newSetAt adalah titik baru "mulai", expiry = newSetAt + 30 hari
    // Sebenarnya lebih simpel: kita geser activation_set_at maju
    const currentSetAt = consignor.activation_set_at ? new Date(consignor.activation_set_at) : new Date();
    currentSetAt.setDate(currentSetAt.getDate() + extendDays);

    await Consignors.update(
      { activation_set_at: currentSetAt },
      { where: { consignor_id: consignor.consignor_id } }
    );

    const newExpiry = new Date(currentSetAt);
    newExpiry.setDate(newExpiry.getDate() + ACTIVATION_DAYS);

    return res.json({
      success: true,
      message: `Masa aktif ${consignor.full_name} berhasil diperpanjang ${extendDays} hari.`,
      new_expires_at: newExpiry.toISOString()
    });
  } catch (err) {
    console.error('[ADMIN/EXTEND-ACTIVATION] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan.' });
  }
});

// ==========================================
// CRUD USER UNTUK ADMIN
// ==========================================

// POST /api/admin/users (Tambah User Baru)
router.post('/admin/users', verifyAdminSecret, async (req, res) => {
  try {
    const { full_name, email, phone, password, store_name, total_capital } = req.body;

    if (!full_name || !phone || !password) {
      return res.status(400).json({ success: false, message: 'Nama, phone, dan password wajib diisi' });
    }

    const existing = await Consignors.findOne({ where: { phone } });
    if (existing) return res.status(409).json({ success: false, message: 'Nomor telepon sudah terdaftar' });

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await Consignors.create({
      full_name,
      email: email || null,
      phone,
      password: hashedPassword,
      store_name: store_name || null,
      total_capital: total_capital || 0,
      last_login: new Date(),
      role: 'Consignor'
    });

    return res.json({
      success: true,
      message: 'User berhasil ditambahkan',
      user_id: newUser.consignor_id
    });
  } catch (err) {
    console.error('[ADMIN/CREATE-USER] Error:', err.message);
    res.status(500).json({ success: false, message: 'Gagal menambah user' });
  }
});

// PUT /api/admin/users/:id (Update User)
router.put('/admin/users/:id', verifyAdminSecret, async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, email, phone, password, store_name, total_capital } = req.body;

    const user = await Consignors.findByPk(id);
    if (!user) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    const updateData = {
      full_name,
      email: email || null,
      phone,
      store_name: store_name || null,
      total_capital: total_capital || 0
    };

    if (password && password.length >= 6) {
      updateData.password = await bcrypt.hash(password, 10);
    }

    await Consignors.update(updateData, { where: { consignor_id: id } });

    return res.json({ success: true, message: 'Data user berhasil diperbarui' });
  } catch (err) {
    console.error('[ADMIN/UPDATE-USER] Error:', err.message);
    res.status(500).json({ success: false, message: 'Gagal memperbarui user' });
  }
});

// DELETE /api/admin/users/:id (Hapus User)
router.delete('/admin/users/:id', verifyAdminSecret, async (req, res) => {
  try {
    const { id } = req.params;

    // Hapus device terkait dulu biar nggak error foreign key (jika ada)
    await DeviceActivation.destroy({ where: { consignor_id: id } });

    const deleted = await Consignors.destroy({ where: { consignor_id: id } });
    if (!deleted) return res.status(404).json({ success: false, message: 'User tidak ditemukan' });

    return res.json({ success: true, message: 'User berhasil dihapus' });
  } catch (err) {
    console.error('[ADMIN/DELETE-USER] Error:', err.message);
    res.status(500).json({ success: false, message: 'Gagal menghapus user' });
  }
});

module.exports = router;
