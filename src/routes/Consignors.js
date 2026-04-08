const Consignors = require('../models/Consignors');
const DeviceActivation = require('../models/DeviceActivation');
const express = require('express');
const app = express();
const { Op } = require('sequelize');
const bcrypt = require('bcrypt');
const jwt = require("jsonwebtoken");

const MAX_DEVICES = 2;
const ACTIVATION_DAYS = 30;

function isActivationExpired(activationSetAt) {
  if (!activationSetAt) return true;
  const expiry = new Date(activationSetAt);
  expiry.setDate(expiry.getDate() + ACTIVATION_DAYS);
  return new Date() > expiry;
}

// Fix #2: Endpoint GET /test-db DIHAPUS — bocorkan seluruh data user tanpa auth

app.post('/consignors', async (req, res) => {
  try {
    const { full_name, email, password, phone } = req.body;

    if (!full_name || !email || !password || !phone) {
      return res.status(400).json({ success: false, message: 'Semua field wajib diisi' });
    }
    if (password.length < 8) {
      return res.status(400).json({ success: false, message: 'Password minimal 8 karakter' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const consignor = await Consignors.create({
      full_name,
      email,
      password: hashedPassword,
      phone,
      total_capital: 0,
      last_login: new Date()
    });

    // Fix #6: Hanya kembalikan field aman, bukan seluruh record
    res.json({
      success: true,
      data: {
        consignor_id: consignor.consignor_id,
        full_name: consignor.full_name,
        email: consignor.email,
        phone: consignor.phone,
        store_name: consignor.store_name,
        profile_photo: consignor.profile_photo,
      }
    });

  } catch (err) {
    console.error('[REGISTER] Error:', err.message);
    // Fix #6: Sanitasi — deteksi duplikat secara khusus, selain itu generic
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ success: false, message: 'Email atau nomor telepon sudah terdaftar' });
    }
    res.status(500).json({ success: false, message: 'Registrasi gagal. Coba lagi nanti.' });
  }
});

app.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;

    if (!phone || !password) {
      return res.status(400).json({ success: false, message: 'phone dan password wajib diisi' });
    }

    // Fix #1: Fail-fast jika JWT_SECRET tidak ada
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      console.error('[SECURITY] JWT_SECRET tidak di-set!');
      return res.status(500).json({ success: false, message: 'Konfigurasi server tidak lengkap.' });
    }

    const user = await Consignors.findOne({ where: { phone } });

    // Fix #6: Pesan generik — cegah user enumeration attack
    if (!user) {
      return res.status(401).json({ success: false, message: 'Nomor telepon atau password salah' });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Nomor telepon atau password salah' });
    }

    // ─────────────────────────────────────────────────
    // INTEGRATED DEVICE ACTIVATION LOGIC
    // ─────────────────────────────────────────────────
    const device_id = req.body.device_id || req.headers['x-device-id'];
    const device_name = req.body.device_name || "Unknown Device";
    const activation_code = req.body.activation_code;

    if (!device_id) {
      return res.status(400).json({ success: false, message: 'Device ID tidak ditemukan dari perangkat Anda.' });
    }

    let sharedAccountIds = [user.consignor_id];
    if (user.activation) {
      const sharedAccounts = await Consignors.findAll({ where: { activation: user.activation } });
      sharedAccountIds = sharedAccounts.map(a => a.consignor_id);
    }

    const existingDevice = await DeviceActivation.findOne({
      where: { 
        consignor_id: { [Op.in]: sharedAccountIds }, 
        device_id 
      }
    });

    if (existingDevice) {
      // Perangkat sudah terdaftar secara grup, perbarui owner terkini & waktu terakhir digunakan
      await existingDevice.update({ consignor_id: user.consignor_id, last_used_at: new Date() });
    } else {
      // Ini adalah perangkat baru, butuh 'activation_code'
      if (!activation_code) {
        return res.status(403).json({
          success: false,
          needsActivation: true,
          message: 'Ini adalah perangkat baru. Silakan masukkan Kode Aktivasi untuk perangkat ini.'
        });
      }

      // Validasi status kode aktivasi
      if (!user.activation) {
        return res.status(401).json({ success: false, message: 'Akun Anda belum memiliki kode aktivasi. Hubungi Admin.' });
      }

      if (isActivationExpired(user.activation_set_at)) {
        return res.status(403).json({ success: false, message: 'Kode aktivasi sudah kadaluarsa. Hubungi Admin JITU.' });
      }

      // LOGIKA BARU: LISENSI BERSAMA (PLAIN TEXT)
      // Kode aktivasi sekarang disimpan mentah untuk bisa dicopy. 
      // Jaga mundur kompatibilitas jika masih di-hash (>40 karakter)
      let isActivationMatch = false;
      if (user.activation.length > 40) {
        isActivationMatch = await bcrypt.compare(activation_code, user.activation);
      } else {
        isActivationMatch = (activation_code === user.activation);
      }

      if (!isActivationMatch) {
        return res.status(401).json({ success: false, message: 'Kode aktivasi salah. Silakan periksa kembali.' });
      }

      // Pastikan kuota aktivasi grup tidak melebihi batas (maks 2 perangkat keseluruhan).
      // Hitung total seluruh device yang terafiliasi dengan akun-akun grup ini.
      const totalGroupDevices = await DeviceActivation.count({
        where: { consignor_id: { [Op.in]: sharedAccountIds } }
      });

      if (totalGroupDevices >= MAX_DEVICES) {
        return res.status(403).json({
          success: false,
          message: `Sistem mendeteksi Lisensi Anda sudah mencapai batas maksimal ${MAX_DEVICES} perangkat masuk di sistem. Hubungi Admin JITU / gunakan fitur Hapus Perangkat di Admin Panel.`
        });
      }

      // Tambahkan perangkat baru
      await DeviceActivation.create({
        consignor_id: user.consignor_id,
        device_id,
        device_name,
        last_used_at: new Date()
      });
    }

    // ─────────────────────────────────────────────────


    const token = jwt.sign(
      {
        consignor_id: user.consignor_id,
        phone: user.phone,
        email: user.email,
        full_name: user.full_name,
      },
      secret,
      { expiresIn: "7d" }
    );

    res.json({
      success: true,
      message: "Login berhasil",
      token,
      user: {
        consignor_id: user.consignor_id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        store_name: user.store_name,
        profile_photo: user.profile_photo,
      }
    });

  } catch (err) {
    console.error('[LOGIN] Error:', err.message);
    res.status(500).json({ success: false, message: 'Terjadi kesalahan. Coba lagi nanti.' });
  }
});

// POST /api/verify-activation
// Endpoint ini digunakan oleh frontend (misal Profile page) untuk menarik informasi 
// session device seperti masa aktif dan nama tanpa merusak flow login.
app.post('/verify-activation', async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) return res.status(400).json({ success: false, message: 'device_id wajib diisi' });

    const device = await DeviceActivation.findOne({ where: { device_id } });

    if (!device) {
      return res.json({ success: false, activated: false });
    }

    const consignor = await Consignors.findOne({ where: { consignor_id: device.consignor_id } });
    if (!consignor || isActivationExpired(consignor.activation_set_at)) {
      return res.json({
        success: false,
        activated: false,
        expired: true,
        message: 'Masa aktif kode aktivasi sudah habis. Hubungi Admin JITU.'
      });
    }

    await device.update({ last_used_at: new Date() });

    let expiresAt = null;
    if (consignor.activation_set_at) {
      const expiry = new Date(consignor.activation_set_at);
      expiry.setDate(expiry.getDate() + ACTIVATION_DAYS);
      expiresAt = expiry.toISOString();
    }

    return res.json({
      success: true,
      activated: true,
      consignor_id: device.consignor_id,
      full_name: consignor.full_name,
      activation_set_at: consignor.activation_set_at,
      expires_at: expiresAt
    });
  } catch (err) {
    console.error('[VERIFY-ACTIVATION] Error:', err.message);
    return res.status(500).json({ success: false, message: 'Terjadi kesalahan.' });
  }
});

module.exports = app;
