const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const { requireAuth } = require("../middlewares/auth");
const OpenAI = require("openai");
const Consignors = require("../models/Consignors");

// ─────────────────────────────────────────────────
// Flexible AI Client (OpenAI-compatible API)
// ─────────────────────────────────────────────────
const aiClient = new OpenAI({
  baseURL: process.env.AI_PROVIDER_URL || "https://api.deepseek.com",
  apiKey: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY,
});

const modelAI = process.env.AI_MODEL || "deepseek-chat";
const enableThinking = process.env.AI_ENABLE_THINKING === "true";

// ─────────────────────────────────────────────────
// In-memory cache: { [userId_dataHash]: { result, cachedAt } }
// TTL: 30 menit — cukup untuk satu sesi kerja
// ─────────────────────────────────────────────────
const analysisCache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 menit

function getCacheKey(userId, summary) {
  const hash = crypto.createHash("md5").update(JSON.stringify(summary)).digest("hex");
  return `${userId}_${hash}`;
}

function getCache(key) {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCache(key, result) {
  analysisCache.set(key, { result, cachedAt: Date.now() });
}


// ─────────────────────────────────────────────────
// POST /api/ai/analyze
// Body: { transactions, products, stores, product_stores }
// Auth: Bearer token
// ─────────────────────────────────────────────────
router.post("/ai/analyze", requireAuth, async (req, res) => {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error("❌ [AI] DEEPSEEK_API_KEY tidak ditemukan di .env!");
    return res.status(503).json({
      success: false,
      message: "AI service belum dikonfigurasi. Hubungi administrator.",
    });
  }

  const startTime = Date.now();
  console.log("\n" + "═".repeat(60));
  console.log("🚀 [AI] Request analisis masuk");
  try {
    // ── Ambil Data Profil User dari DB ──
    const userProfile = await Consignors.findOne({
      where: { consignor_id: req.user.consignor_id },
      attributes: ["full_name", "store_name", "last_login"],
    });

    const { transactions = [], products = [], stores = [], product_stores = [] } = req.body;

    // ── Log data masuk dari frontend ──
    console.log("📦 [AI] DATA MASUK DARI FRONTEND:");
    console.log(`   • Transaksi    : ${transactions.length} record`);
    console.log(`   • Produk       : ${products.length} item`);
    console.log(`   • Toko konsin  : ${stores.length} toko`);
    console.log(`   • Titipan      : ${product_stores.length} item`);

    if (transactions.length > 0) {
      console.log(`   • Contoh transaksi[0]:`, JSON.stringify(transactions[0], null, 2));
    }
    if (products.length > 0) {
      console.log(`   • Contoh produk[0]:`, JSON.stringify(products[0], null, 2));
    }

    // ── Validasi minimal data ──
    if (transactions.length === 0 && products.length === 0) {
      console.warn("⚠️  [AI] Data kosong — request ditolak");
      return res.status(400).json({
        success: false,
        message: "Data toko masih kosong. Tambahkan transaksi atau produk terlebih dahulu.",
      });
    }

    // ── Ringkas data agar tidak terlalu berat dikirim ke AI ──
    const summary = buildSummary({
      transactions,
      products,
      stores,
      product_stores,
      profile: userProfile
    });

    // ── Cek cache dulu ──
    const userId = req.user?.consignor_id || req.user?.phone || req.user?.email;
    const cacheKey = getCacheKey(userId, summary);
    const cached = getCache(cacheKey);

    if (cached) {
      console.log(`⚡ [AI] CACHE HIT — returning cached stream`);
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`data: ${JSON.stringify({ type: "done", data: cached, fromCache: true })}\n\n`);
      return res.end();
    }

    console.log(`🔍 [AI] Cache MISS — memanggil ${modelAI} (Thinking: ${enableThinking})`);

    // ── Setup SSE ──
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    console.log("\n📊 [AI] RINGKASAN YANG DIKIRIM KE DEEPSEEK:");
    console.log(JSON.stringify(summary, null, 2));
    console.log("─".repeat(60));

    // ── Prompt ──
    const systemPrompt = `Kamu adalah analis bisnis AI untuk aplikasi JITU, sebuah aplikasi manajemen UMKM Indonesia.
Tugasmu adalah menganalisis data bisnis yang diberikan dan memberikan insight yang ACTIONABLE, SINGKAT, dan MUDAH DIPAHAMI.

KONTEKS USER:
- Nama Pemilik: ${summary.user_profile.nama}
- Nama Bisnis/Toko: ${summary.user_profile.nama_toko}

ATURAN KERAS — WAJIB DIIKUTI:
1. Sapalah user dengan hangat menggunakan nama pemilik dan sebutkan nama bisnisnya di awal "personal_note".
2. Untuk market/strategy/prediction/inventory: HARUS berdasarkan data yang diberikan. JANGAN mengarang.
2. Untuk tren_indonesia: berikan tren produk UMKM yang sedang populer di Indonesia saat ini berdasarkan pengetahuanmu. Fokus ke kategori makanan, minuman, fashion, dan kebutuhan sehari-hari.
3. Field "relevan" di tren_indonesia = true jika tren tersebut relevan/mirip dengan produk yang dimiliki user.
4. Gunakan bahasa Indonesia yang sederhana. Semua angka REALISTIS.
5. JANGAN pernah mengubah kesimpulan jika datanya sama.
6. Field "personal_note": INI SANGAT PENTING. Berikan analisis menyeluruh yang panjang dan mendalam. Bicaralah seperti konsultan bisnis senior yang sangat peduli pada keberhasilan UMKM tersebut. Gabungkan temuan dari tren pasar, strategi stok, dan prediksi profit menjadi satu narasi yang koheren. Berikan kalimat pembuka yang hangat, isi yang detail (minimal 3 paragraf pendek atau total 100-150 kata), dan kalimat penutup yang memberi motivasi dan semangat tinggi. Hindari gaya bahasa kaku atau robotik.
7. Field "peak_hour": Berikan deskripsi singkat tentang kapan toko paling ramai berdasarkan data jam transaksi yang diberikan (misal: "Pukul 16:00 - 18:00").

Kembalikan HANYA JSON valid (tanpa markdown, tanpa penjelasan) dengan struktur ini:
{
  "personal_note": "string — pesan motivasi dan rekomendasi menyeluruh yang sangat personal, hangat, dan mendalam bagi pemilik UMKM",
  "peak_hour": "string — deskripsi jam teramai (misal: 17:00 - 19:00)",
  "market": {
    "headline": "string — judul singkat peluang pasar (maks 8 kata)",
    "summary": "string — kalimat pendek pengantar (maks 15 kata)",
    "topProduct": "string — nama produk/kategori terlaris berdasarkan data",
    "growthBadge": "string — badge misal '↑ 2×' atau '+45%', berdasarkan data",
    "contextTags": ["tag1", "tag2", "tag3"]
  },
  "strategy": {
    "headline": "string — judul saran strategis (maks 8 kata)",
    "summary": "string — kalimat pendek pengantar (maks 15 kata)",
    "steps": [
      { "text": "string — langkah konkret (maks 12 kata)", "tag": "string — misal 'Hari ini' atau 'Minggu ini'" },
      { "text": "...", "tag": "..." },
      { "text": "...", "tag": "..." }
    ]
  },
  "prediction": {
    "headline": "string — judul prediksi (maks 8 kata)",
    "summary": "string — kalimat pendek pengantar (maks 15 kata)",
    "optimistic": "string — persentase optimis misal '+15%'",
    "moderate": "string — persentase moderat misal '+8%'",
    "confidence": number,
    "detail": "string — penjelasan singkat (maks 20 kata)"
  },
  "inventory": {
    "headline": "string — judul peringatan stok (maks 8 kata)",
    "summary": "string — kalimat pendek pengantar (maks 15 kata)",
    "items": [
      { "name": "string — nama produk dari data", "days": "string — misal '38 hari'", "urgent": boolean }
    ],
    "detail": "string — saran singkat (maks 20 kata)"
  },
  "tren_indonesia": {
    "headline": "string — judul tren (maks 8 kata)",
    "summary": "string — kalimat pengantar singkat (maks 15 kata)",
    "items": [
      { "nama": "string — nama produk/kategori trending", "alasan": "string — kenapa lagi viral (maks 10 kata)", "relevan": boolean },
      { "nama": "...", "alasan": "...", "relevan": boolean },
      { "nama": "...", "alasan": "...", "relevan": boolean }
    ],
    "tips": "string — saran konkret untuk UMKM ini berdasarkan tren (maks 20 kata)"
  }
}`;

    const userPrompt = `Analisis data bisnis UMKM berikut dengan KONSISTEN. Jangan mengarang data yang tidak ada:\n\n${JSON.stringify(summary, null, 2)}`;

    // ── Seed deterministik berdasarkan konten data ──
    const dataHash = crypto.createHash("md5").update(JSON.stringify(summary)).digest("hex");
    const seed = parseInt(dataHash.slice(0, 8), 16) % 2147483647;
    console.log(`🎲 [AI] Seed: ${seed} (hash: ${dataHash.slice(0, 8)}...)`);

    // ── Panggil AI Streaming ──
    console.log(`🤖 [AI] Panggil ${modelAI}...`);
    const stream = await aiClient.chat.completions.create({
      model: modelAI,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 8192,
      stream: true,
      stream_options: { include_usage: true },
      ...(enableThinking ? { enable_thinking: true } : {}),
      ...(seed ? { seed } : {}),
    });

    let fullContent = "";
    let fullReasoning = "";
    let tokenUsage = null;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta || {};

      // Tangkap Proses Berpikir (Reasoning)
      const reasoning = delta.reasoning_content || delta.reasoning;
      if (reasoning) {
        fullReasoning += reasoning;
        res.write(`data: ${JSON.stringify({ type: "thinking", content: reasoning })}\n\n`);
      }

      // Tangkap Konten Utama
      const content = delta.content || "";
      if (content) {
        fullContent += content;
        res.write(`data: ${JSON.stringify({ type: "content", content: content })}\n\n`);
      }

      // Tangkap Penggunaan Token (berada di chunk paling terakhir biasanya)
      if (chunk.usage) {
        tokenUsage = chunk.usage;
      }
    }

    // ── Selesai — Parse & Simpan ke Cache ──
    if (tokenUsage) {
      console.log("\n✅ [AI] Selesai Streaming.");
      console.log(`📊 [TOKEN USAGE] Input: ${tokenUsage.prompt_tokens} | Output: ${tokenUsage.completion_tokens} | Total: ${tokenUsage.total_tokens}`);
    } else {
      console.log("\n✅ [AI] Selesai Streaming.");
    }
    let parsedData = {};
    try {
      // Hilangkan markdown blocks jika ada
      const cleanContent = fullContent.replace(/```json|```/g, "").trim();
      parsedData = JSON.parse(cleanContent);
      setCache(cacheKey, parsedData);
    } catch (e) {
      console.error("❌ [AI] Gagal parse JSON final dari stream:", e.message);
      res.write(`data: ${JSON.stringify({ type: "error", message: "Gagal memproses data final." })}\n\n`);
      return res.end();
    }

    res.write(`data: ${JSON.stringify({ type: "done", data: parsedData })}\n\n`);
    res.end();
  } catch (err) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.error(`\n❌ [AI] ERROR setelah ${elapsed}s:`);
    console.error(`   • Status : ${err?.status || "N/A"}`);
    console.error(`   • Pesan  : ${err?.message || err}`);
    if (err?.error) console.error(`   • Detail :`, err.error);
    console.log("═".repeat(60) + "\n");

    // Error khusus dari API DeepSeek
    if (err?.status === 401) {
      return res.status(503).json({ success: false, message: "API Key DeepSeek tidak valid." });
    }
    if (err?.status === 429) {
      return res.status(429).json({ success: false, message: "Batas penggunaan AI tercapai. Coba lagi sebentar." });
    }
    if (err?.status === 402) {
      return res.status(402).json({ success: false, message: "Saldo API DeepSeek habis. Isi ulang untuk melanjutkan." });
    }

    return res.status(500).json({ success: false, message: "Terjadi kesalahan pada layanan AI. Coba lagi." });
  }
});

// ─────────────────────────────────────────────────
// Helper: Buat ringkasan data yang relevan untuk AI
// Struktur JITU:
//   transactions = [{ id, items: [{id, nama_produk, harga_jual, qty}], subtotal, created_at }]
//   products     = [{ id, nama_produk, harga_jual, stok, kategori }]
//   product_stores = konsinyasi titipan
// ─────────────────────────────────────────────────
function buildSummary({ transactions, products, stores, product_stores, profile }) {

  // ── Info User ──
  const user_profile = {
    nama: profile?.full_name || "-",
    nama_toko: profile?.store_name || "Toko Mitra JITU",
  };

  // ── Produk: daftar lengkap (max 200) ──
  const productSummary = products.slice(0, 200).map((p) => ({
    nama: p.nama_produk || p.product_name || "-",
    stok: p.stok ?? p.stock ?? 0,
    harga: p.harga_jual ?? p.price ?? 0,
    kategori: p.kategori || p.category || "Umum",
    kode_produk: p.kode_produk || p.product_code || "-",
  }));

  // ── Transaksi: ambil 500 terbaru ──
  const recentTx = transactions.slice(-500);

  // Total pendapatan dari field subtotal
  const totalRevenue = recentTx.reduce((sum, t) =>
    sum + Number(t.subtotal || t.total_price || t.total || 0), 0
  );

  // Flatten semua items dari setiap transaksi
  const allItems = [];
  recentTx.forEach((t) => {
    if (Array.isArray(t.items)) {
      t.items.forEach((item) => {
        allItems.push({
          nama: item.nama_produk || item.product_name || "-",
          qty: Number(item.qty || item.quantity || 1),
          harga: Number(item.harga_jual || item.price || 0),
          kategori: item.kategori || "Umum",
        });
      });
    }
  });

  const totalQty = allItems.reduce((sum, i) => sum + i.qty, 0);

  // Frekuensi penjualan per nama produk
  const freqMap = {};
  allItems.forEach((item) => {
    const key = item.nama !== "-" ? item.nama : "Produk Tidak Dikenal";
    freqMap[key] = (freqMap[key] || 0) + item.qty;
  });

  const topSelling = Object.entries(freqMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([nama, qty]) => ({ nama, terjual: qty }));

  // Rata-rata transaksi per hari (jika ada data tanggal)
  let avgPerDay = null;
  if (recentTx.length >= 2) {
    const dates = recentTx
      .map((t) => new Date(t.created_at).getTime())
      .filter((d) => !isNaN(d))
      .sort((a, b) => a - b);
    if (dates.length >= 2) {
      const daySpan = Math.max(1, (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24));
      avgPerDay = (totalRevenue / daySpan).toFixed(0);
    }
  }

  // ── Jam Sibuk: kelompokkan per jam ──
  const hourMap = {};
  recentTx.forEach((t) => {
    const hour = new Date(t.created_at).getHours();
    if (!isNaN(hour)) {
      hourMap[hour] = (hourMap[hour] || 0) + 1;
    }
  });
  const peakHours = Object.entries(hourMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([h, count]) => ({ jam: `${h}:00`, transaksi: count }));

  // ── Stok lama: produk dengan stok > 0 yang tidak ada di transaksi ──
  const soldNames = new Set(allItems.map((i) => i.nama));
  const staleProducts = products
    .filter((p) => {
      const nama = p.nama_produk || p.product_name || "";
      const stok = p.stok ?? p.stock ?? 0;
      return stok > 0 && !soldNames.has(nama);
    })
    .slice(0, 15)
    .map((p) => ({
      nama: p.nama_produk || p.product_name || "-",
      stok: p.stok ?? p.stock ?? 0,
      harga: p.harga_jual ?? p.price ?? 0,
    }));

  // ── Konsinyasi: produk titipan lama ──
  const staleTitipan = product_stores
    .filter((ps) => {
      const created = new Date(ps.created_at || ps.createdAt || ps.tanggal_titip);
      const daysSince = (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24);
      return !isNaN(daysSince) && daysSince > 20;
    })
    .slice(0, 15)
    .map((ps) => ({
      nama_produk: ps.nama_produk || ps.product_name || ps.product_code || "-",
      toko: ps.store_name || ps.storeId || ps.store_id || "-",
      stok_titip: ps.stokTitip || ps.stok_titip || 0,
      hari_berlalu: Math.floor(
        (Date.now() - new Date(ps.created_at || ps.createdAt || ps.tanggal_titip).getTime()) /
        (1000 * 60 * 60 * 24)
      ),
    }));

  // ── Ringkasan Toko Konsinyasi Aktif ──
  const activeConsignment = stores.map((s) => {
    const storeItems = product_stores.filter(ps => (ps.store_name === s.store_name || ps.storeId === s.id));
    return {
      toko: s.store_name || "-",
      jumlah_produk_dititip: storeItems.length,
      produk_paling_lama: storeItems.sort((a, b) => {
        const dateA = new Date(a.created_at || a.tanggal_titip).getTime();
        const dateB = new Date(b.created_at || b.tanggal_titip).getTime();
        return dateA - dateB;
      })[0]?.nama_produk || "-"
    };
  });

  return {
    user_profile,
    summary_analisis: {
      total_penjualan: totalRevenue,
      total_item_terjual: totalQty,
      total_pendapatan: totalRevenue,
      rata_rata_per_hari: avgPerDay ? `Rp${Number(avgPerDay).toLocaleString("id-ID")}` : "tidak tersedia",
      jam_sibuk: peakHours,
      konsinyasi_aktif: activeConsignment,
    },
    produk_terlaris: topSelling,
    daftar_produk: productSummary,
    stok_mengendap_di_gudang: staleProducts,
    stok_mengendap_di_toko_mitra: staleTitipan,
    meta: {
      jumlah_total_produk: products.length,
      jumlah_toko_mitra: stores.length
    }
  };
}

module.exports = router;
