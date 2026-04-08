const express = require("express");
const Products = require("../models/Products");
const Sales = require("../models/Sales");
const Consignors = require("../models/Consignors");
const { sequelize } = require("../config/sequelize");
const { requireAuth } = require("../middlewares/auth");

const router = express.Router();

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toDateOnly(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function resolveProductCode(item, index) {
  const nameCandidate = item?.product_name ?? item?.name ?? item?.nama_produk ?? item?.nama;
  const nameSlug = slugify(nameCandidate);
  const nameKey = nameSlug ? `name:${nameSlug}` : "";

  const candidates = [
    item?.product_code,
    item?.productCode,
    item?.code,
    item?.kode,
    item?.id,
    item?.product_id,
    item?.productId,
    nameKey,
  ];

  for (const candidate of candidates) {
    const normalized = String(candidate ?? "").trim();
    if (normalized) return normalized;
  }

  const slug = slugify(nameCandidate);
  if (slug) return `${slug}-${index + 1}`;

  return "";
}

function resolveStock(item) {
  return toNumber(item?.stock ?? item?.stok ?? item?.quantity ?? item?.qty ?? 0, 0);
}

function resolveClientRef(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "";
}

function resolvePsId(trx, productCodeToPsId, clientRefToPsId) {
  const direct = toNumber(trx?.ps_id ?? trx?.product_store_id ?? trx?.productStoreId ?? 0, 0);
  if (direct) return direct;

  const clientRefCandidates = [
    trx?.client_ref,
    trx?.clientRef,
    trx?.product_ref,
    trx?.productRef,
    trx?.product_id,
    trx?.productId,
    trx?.id,
  ];

  for (const ref of clientRefCandidates) {
    const key = resolveClientRef(ref);
    if (key && clientRefToPsId.has(key)) {
      return clientRefToPsId.get(key);
    }
  }

  const referenceCandidates = [
    trx?.product_code,
    trx?.productCode,
    trx?.code,
    trx?.kode,
    trx?.id,
    trx?.product_id,
    trx?.productId,
  ];

  for (const ref of referenceCandidates) {
    const key = String(ref ?? "").trim();
    if (key && productCodeToPsId.has(key)) {
      return productCodeToPsId.get(key);
    }
  }

  const nameCandidate = trx?.product_name ?? trx?.name ?? trx?.nama_produk ?? trx?.nama;
  const nameSlug = slugify(nameCandidate);
  const nameKey = nameSlug ? `name:${nameSlug}` : "";
  if (nameKey && productCodeToPsId.has(nameKey)) {
    return productCodeToPsId.get(nameKey);
  }

  return 0;
}

function pickFirst(...values) {
  for (const value of values) {
    const normalized = String(value ?? "").trim();
    if (normalized) return normalized;
  }
  return "";
}

function normalizeStoreType(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return v === "kelontong" ? "kelontong" : "lainnya";
}

function normalizeCommissionUnit(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "nominal") return "nominal";
  return "persentase";
}

function normalizeKey(value) {
  return String(value ?? "").trim().toLowerCase();
}

router.post("/sync/pos", requireAuth, async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : [];
  const transactions = Array.isArray(req.body?.transactions) ? req.body.transactions : [];
  const stores = Array.isArray(req.body?.stores) ? req.body.stores : [];
  const consignments = Array.isArray(req.body?.product_stores)
    ? req.body.product_stores
    : Array.isArray(req.body?.consignments)
    ? req.body.consignments
    : Array.isArray(req.body?.titipan)
    ? req.body.titipan
    : [];
  const settings = req.body?.settings || null;

  // [AUTOMATIC SCHEMA UPDATE]
  // Memastikan kolom baru ada di database sebelum proses sinkronisasi dimulai
  try {
     await sequelize.query("ALTER TABLE product_stores ADD COLUMN IF NOT EXISTS loss_amount DECIMAL(10,2) DEFAULT 0");
     await sequelize.query("ALTER TABLE product_stores ADD COLUMN IF NOT EXISTS loss_quantity INTEGER DEFAULT 0");
     await sequelize.query("ALTER TABLE product_stores ADD COLUMN IF NOT EXISTS remaining_stock_action VARCHAR(50) DEFAULT NULL");
  } catch (e) {
     // Abaikan jika kolom sudah ada atau database tidak mendukung IF NOT EXISTS (tergantung dialek)
     console.log("[DB-UPDATE-NOTICE] Schema update check completed.");
  }

  const result = {
    success: true,
    settings: { upserted: false, error: null },
    products: { total: products.length, upserted: 0, failed: 0, errors: [] },
    transactions: { total: transactions.length, upserted: 0, failed: 0, errors: [] },
    stores: { total: stores.length, upserted: 0, failed: 0, errors: [] },
    product_stores: { total: consignments.length, upserted: 0, failed: 0, errors: [] },
  };

  if (settings) {
    try {
      await Consignors.update(
        {
          full_name: settings.ownerName || undefined,
          email: settings.ownerEmail || undefined,
          phone: settings.ownerPhone || undefined,
          store_name: settings.storeName || undefined,
          profile_photo: settings.profilePhoto || undefined,
        },
        { where: { consignor_id: req.user.consignor_id } }
      );
      result.settings.upserted = true;
    } catch (err) {
      result.settings.error = err.message;
    }
  }

  const productCodeToPsId = new Map();
  const clientRefToPsId = new Map();
  const storeRefToStoreId = new Map();

  // ==========================================
  // SYNC STORES (TOKO KONSINYASI)
  // ==========================================
  for (let i = 0; i < stores.length; i += 1) {
    const s = stores[i];
    try {
      const store_name = pickFirst(s.nama_toko, s.store_name, s.name, s.nama, "Toko Konsinyasi");
      const address = pickFirst(s.lokasi_toko, s.address, s.alamat, "-");
      const owner_name = pickFirst(s.pemilik, s.owner, s.owner_name, "Pemilik");
      const phone = pickFirst(s.kontak, s.phone, s.no_hp, s.telp, "-");
      
      const comm_unit = s.komisi_persen || s.commision_unit === 'persentase' ? 'persentase' : 
                        (s.komisi_nominal || s.commision_unit === 'nominal' ? 'nominal' : 'persentase');
      const comm_val = s.komisi_persen || s.komisi_nominal || s.commision || 0;

      // Cari berdasarkan ID (jika sudah ada di DB) atau Nama Toko (untuk yang baru)
      const [existing] = await sequelize.query(
        "SELECT store_id FROM stores WHERE consignor_id = ? AND (store_id = ? OR (store_name = ? AND store_name != 'Toko Konsinyasi')) LIMIT 1",
        { replacements: [req.user.consignor_id, Number(s.id) || -1, store_name] }
      );

      let storeId = existing?.[0]?.store_id || null;

      if (storeId) {
        await sequelize.query(
          "UPDATE stores SET store_name=?, address=?, owner_name=?, phone=?, commision_unit=?, commision=? WHERE store_id=?",
          { replacements: [store_name, address, owner_name, phone, comm_unit, comm_val, storeId] }
        );
      } else {
        const [inserted] = await sequelize.query(
          "INSERT INTO stores (consignor_id, store_name, address, owner_name, phone, commision_unit, commision) VALUES (?, ?, ?, ?, ?, ?, ?)",
          { replacements: [req.user.consignor_id, store_name, address, owner_name, phone, comm_unit, comm_val] }
        );
        // inserted ini biasanya insertId di MySQL
        storeId = inserted?.insertId || inserted;
      }

      if (storeId) {
        const keys = [
          String(s.id),
          normalizeKey(s.id),
          String(store_name),
          normalizeKey(store_name)
        ].filter(Boolean);

        for (const key of keys) {
          storeRefToStoreId.set(key, Number(storeId));
        }
      }
      
      result.stores.upserted += 1;
    } catch (err) {
      console.error("[SYNC-STORE-FAIL]", err.message);
      result.stores.failed += 1;
      result.stores.errors.push({ index: i, message: err.message });
    }
  }


  for (let i = 0; i < products.length; i += 1) {
    const item = products[i];
    try {
      const productCode = resolveProductCode(item, i);
      if (!productCode) throw new Error("product_code kosong");

      const clientRef = resolveClientRef(
        item?.client_ref ?? item?.clientRef ?? item?.product_ref ?? item?.productRef ?? item?.product_id ?? item?.productId ?? item?.id
      );

      const payload = {
        product_code: productCode,
        client_ref: clientRef || null,
        consignor_id: req.user?.consignor_id ?? null,
        product_name: String(item?.product_name ?? item?.name ?? item?.nama_produk ?? "Produk Tanpa Nama"),
        category: item?.category ?? item?.kategori ?? null,
        description: item?.description ?? item?.deskripsi ?? null,
        price: toNumber(item?.price ?? item?.harga_jual ?? item?.harga ?? 0, 0),
        stock: toNumber(item?.stock ?? item?.stok ?? 0, 0),
        unit: item?.unit ?? item?.satuan ?? "pcs",
        expiry_date: item?.expiry_date || null,
        image_path: item?.image_path || item?.gambar_base64 || null,
        updated_at: item?.updated_at || new Date()
      };

      console.log(`[SYNC-PROD] Upserting Code: ${productCode}, Name: ${payload.product_name}, Stock: ${payload.stock}`);

      const existing = await Products.findOne({
        where: {
          product_code: productCode,
          consignor_id: req.user?.consignor_id ?? null,
        },
      });

      if (existing) {
        payload.id = existing.id;
        console.log(`[SYNC-PROD-MATCH] Found Existing ID: ${existing.id} for Code: ${productCode}`);
      }
      
      console.log(`[SYNC-PROD] Upserting Code: ${productCode}, Name: ${payload.product_name}, Stock: ${payload.stock}, UpdatedAt: ${payload.updated_at}`);
      
      const [persistedModel] = await Products.upsert(payload, { returning: true });
      
      const productId = persistedModel?.id || existing?.id;
      
      if (productId) {
        console.log(`[SYNC-PROD-SUCCESS] Code: ${productCode}, ID: ${productId}`);
        result.products.upserted += 1;
        productCodeToPsId.set(String(productCode), Number(productId));
        if (clientRef) {
          clientRefToPsId.set(clientRef, Number(productId));
        }
        const nameSlug = slugify(payload.product_name);
        if (nameSlug) {
          productCodeToPsId.set(`name:${nameSlug}`, Number(productId));
        }
      }
    } catch (error) {
      console.error(`[SYNC-PROD-FAILED] Index ${i}:`, error.message);
      result.products.failed += 1;
      result.products.errors.push({
        index: i,
        message: error.message,
      });
    }
  }

  const productToOfficialCode = new Map();
  for (const [code, id] of productCodeToPsId.entries()) {
    if (!code.startsWith("name:")) {
      productToOfficialCode.set(Number(id), code);
    }
  }

  for (let i = 0; i < consignments.length; i += 1) {
    const row = consignments[i];
    try {
      const storeRef = pickFirst(row?.store_ref, row?.storeRef, row?.store_id, row?.storeId, row?.nama_toko, row?.store_name);
      let productCode = pickFirst(
        row?.product_code,
        row?.productCode,
        row?.code,
        row?.kode
      );

      const productId = pickFirst(row?.produkId, row?.productId, row?.product_id);

      // Resolusi productCode jika kosong tapi ada productId
      if (!productCode && productId) {
        // Cari di map yang baru dibuat di loop Produk (Line 410)
        productCode = productToOfficialCode.get(Number(productId));
      }

      if (!storeRef) throw new Error("store_ref/store_id kosong");
      if (!productCode) throw new Error("product_code kosong (id lokal tidak boleh jadi kode)");

      const storeRefKey = String(storeRef).trim();
      let resolvedStoreId = storeRefToStoreId.get(storeRefKey) || storeRefToStoreId.get(normalizeKey(storeRefKey));

      if (!resolvedStoreId) {
        const [fallbackStore] = await sequelize.query(
          "SELECT store_id FROM stores WHERE consignor_id = ? AND (store_name = ? OR store_id = ?) ORDER BY store_id DESC LIMIT 1",
          { replacements: [req.user?.consignor_id ?? null, storeRefKey, Number.isFinite(Number(storeRefKey)) ? Number(storeRefKey) : -1] }
        );
        resolvedStoreId = fallbackStore?.[0]?.store_id ?? null;
      }

      if (!resolvedStoreId) throw new Error(`store tidak ditemukan untuk ref: ${storeRef}`);

      const quantity = toNumber(row?.stokTitip ?? row?.quantity ?? row?.qty ?? row?.jumlah ?? 0, 0);
      if (quantity <= 0) throw new Error("quantity (stokTitip) harus > 0");

      const dateConsigned = row?.date_consigned ?? row?.dateConsigned ?? row?.tanggal_titip ?? row?.createdAt ?? new Date();
      const dateReturned = row?.date_returned ?? row?.dateReturned ?? row?.tanggal_kembali ?? "9999-12-31 23:59:59";
      
      const statusRaw = pickFirst(row?.status, "Dititipkan");
      // Map frontend status 'aktif'/'selesai' to DB 'Dititipkan'/'Terjual'
      let status = "Dititipkan";
      if (statusRaw === 'selesai' || statusRaw === 'Terjual') status = 'Terjual';
      else if (statusRaw === 'Dikembalikan') status = 'Dikembalikan';

      const sold_quantity = toNumber(row?.sold_quantity ?? row?.soldQuantity ?? 0, 0);
      const gross_revenue = toNumber(row?.gross_revenue ?? row?.grossRevenue ?? 0, 0);
      const net_revenue = toNumber(row?.net_revenue ?? row?.netRevenue ?? 0, 0);
      const komisi_amount = toNumber(row?.komisi_amount ?? row?.komisiAmount ?? 0, 0);
      const loss_amount = toNumber(row?.loss_amount ?? row?.lossAmount ?? 0, 0);
      const loss_quantity = toNumber(row?.loss_quantity ?? row?.lossQuantity ?? 0, 0);
      const remaining_stock_action = row?.remaining_stock_action ?? row?.remainingStockAction ?? null;
      const estimasi = row?.estimasi || null;

      let existingPsId = null;
      if (Number.isFinite(Number(row?.id)) || Number.isFinite(Number(row?.ps_id))) {
        existingPsId = Number(row?.id || row?.ps_id);
      } else {
        const [activeMatch] = await sequelize.query(
          "SELECT ps_id FROM product_stores WHERE consignor_id = ? AND store_id = ? AND product_code = ? AND status = 'Dititipkan' ORDER BY ps_id DESC LIMIT 1",
          { replacements: [req.user?.consignor_id ?? null, resolvedStoreId, productCode] }
        );
        existingPsId = activeMatch?.[0]?.ps_id ?? null;
      }

      const prevStatusQuery = existingPsId ? await sequelize.query("SELECT status FROM product_stores WHERE ps_id = ?", { replacements: [existingPsId] }) : null;
      const prevStatus = prevStatusQuery?.[0]?.[0]?.status ?? null;

      if (existingPsId) {
        await sequelize.query(
          "UPDATE product_stores SET quantity=?, date_consigned=?, date_returned=?, status=?, sold_quantity=?, gross_revenue=?, net_revenue=?, komisi_amount=?, estimasi=?, loss_amount=?, loss_quantity=?, remaining_stock_action=? WHERE ps_id=?",
          { replacements: [quantity, new Date(dateConsigned), new Date(dateReturned), status, sold_quantity, gross_revenue, net_revenue, komisi_amount, estimasi, loss_amount, loss_quantity, remaining_stock_action, existingPsId] }
        );
      } else {
        await sequelize.query(
          "INSERT INTO product_stores (store_id, consignor_id, product_code, quantity, date_consigned, date_returned, status, sold_quantity, gross_revenue, net_revenue, komisi_amount, estimasi, loss_amount, loss_quantity, remaining_stock_action) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          { replacements: [resolvedStoreId, req.user?.consignor_id ?? null, productCode, quantity, new Date(dateConsigned), new Date(dateReturned), status, sold_quantity, gross_revenue, net_revenue, komisi_amount, estimasi, loss_amount, loss_quantity, remaining_stock_action] }
        );
      }

      // Restock Logic: If returned, add back to master product stock
      if (status === 'Dikembalikan' && prevStatus === 'Dititipkan') {
           await sequelize.query(
               "UPDATE products SET stock = stock + ? WHERE product_code = ? AND consignor_id = ?",
               { replacements: [quantity, productCode, req.user?.consignor_id ?? null] }
           );
      }

      result.product_stores.upserted += 1;
    } catch (error) {
      console.error("[SYNC-PS-FAIL] Index:", i, "Error:", error.message, "Data:", JSON.stringify(row));
      result.product_stores.failed += 1;
      result.product_stores.errors.push({
        index: i,
        message: error.message,
      });
    }
  }



  for (let i = 0; i < transactions.length; i += 1) {
    const rawTrx = transactions[i];
    try {
      const hasItems = Array.isArray(rawTrx?.items) && rawTrx.items.length > 0;
      const receiptId = hasItems ? String(rawTrx?.id ?? rawTrx?.receipt_id ?? `R-${Date.now()}-${i}`) : (rawTrx?.receipt_id ? String(rawTrx.receipt_id) : null);
      const paymentMethod = hasItems ? String(rawTrx?.paymentMethod ?? rawTrx?.payment_method ?? "tunai") : (rawTrx?.payment_method ? String(rawTrx.payment_method) : null);
      const createdAt = new Date(rawTrx?.created_at ?? rawTrx?.createdAt ?? rawTrx?.sale_date ?? new Date());

      const itemsToProcess = hasItems 
        ? rawTrx.items.map(itm => ({
            ...itm,
            sale_date: createdAt,
            receipt_id: receiptId,
            payment_method: paymentMethod,
            created_at: createdAt
          })) 
        : [{ ...rawTrx, created_at: createdAt, receipt_id: receiptId, payment_method: paymentMethod }];

      for (let j = 0; j < itemsToProcess.length; j += 1) {
        const trx = itemsToProcess[j];
        // resolvedProductId adalah internal ID tabel PRODUCTS (bukan PS_ID Konsinyasi)
        const resolvedProductId = resolvePsId(trx, productCodeToPsId, clientRefToPsId);
        
        const officialCode = productToOfficialCode.get(resolvedProductId) || String(
          trx?.product_code ??
            trx?.productCode ??
            trx?.code ??
            trx?.kode ??
            trx?.product_id ??
            trx?.productId ??
            trx?.id ??
            ""
        ).trim();

        const payload = {
          // ps_id untuk jualan POS biasa harus NULL agar tidak bentrok dengan Foreign Key Konsinyasi
          ps_id: (trx?.ps_id || trx?.product_store_id) ? toNumber(trx.ps_id || trx.product_store_id) : null, 
          product_code: officialCode || null,
          quantity_sold: toNumber(trx?.quantity_sold ?? trx?.qty ?? trx?.quantity ?? trx?.jumlah ?? 1, 1),
          total_price: toNumber(trx?.total_price ?? trx?.total ?? (toNumber(trx?.harga_jual ?? trx?.price ?? 0) * toNumber(trx?.qty ?? 1)) ?? trx?.subtotal ?? trx?.harga_total ?? 0, 0),
          sale_date: toDateOnly(trx?.sale_date ?? trx?.date ?? trx?.createdAt),
          receipt_id: trx?.receipt_id || null,
          payment_method: trx?.payment_method || null,
          created_at: trx?.created_at || new Date(),
        };

        console.log(`[SYNC-TRX] Processing Receipt: ${payload.receipt_id}, Prod: ${payload.product_code}, Total: ${payload.total_price}`);

        if (!payload.ps_id && !payload.product_code) {
          console.warn(`[SYNC-TRX-SKIP] Receipt ${payload.receipt_id}: No product reference`);
          result.transactions.failed += 1;
          result.transactions.errors.push({
            index: i,
            message: "transaksi dilewati (item array): referensi produk kosong",
          });
          continue;
        }

        if (payload.receipt_id && payload.product_code) {
          const [existingSale] = await sequelize.query(
            "SELECT sale_id FROM sales WHERE receipt_id = ? AND product_code = ? LIMIT 1",
            { replacements: [payload.receipt_id, payload.product_code] }
          );
          if (existingSale?.[0]?.sale_id) {
            payload.sale_id = existingSale[0].sale_id;
          }
        } else if (trx?.sale_id) {
          payload.sale_id = toNumber(trx.sale_id, 0);
        }

        await Sales.upsert(payload);
        console.log(`[SYNC-TRX-SUCCESS] Receipt: ${payload.receipt_id}`);
        result.transactions.upserted += 1;
      }
    } catch (error) {
      console.error("[SYNC-TRX-ERROR]", error);
      result.transactions.failed += 1;
      result.transactions.errors.push({
        index: i,
        message: error.message,
      });
    }
  }

  if (
    result.products.failed > 0 ||
    result.transactions.failed > 0 ||
    result.stores.failed > 0 ||
    result.product_stores.failed > 0
  ) {
    result.success = false;
  }

  console.log("[SYNC POS] result", {
    success: result.success,
    products: result.products,
    stores: result.stores,
    product_stores: result.product_stores,
    transactions: result.transactions,
  });

  return res.json(result);
});

router.get("/sync/pull", requireAuth, async (req, res) => {
  try {
    const consignor_id = req.user.consignor_id;

    const consignor = await Consignors.findByPk(consignor_id);
    const settings = {
      storeName: consignor?.store_name || "",
      ownerName: consignor?.full_name || "",
      ownerEmail: consignor?.email || "",
      ownerPhone: consignor?.phone || "",
      profilePhoto: consignor?.profile_photo || "",
    };

    const products = await Products.findAll({ where: { consignor_id }, raw: true });

    const [stores] = await sequelize.query("SELECT * FROM stores WHERE consignor_id = ?", {
      replacements: [consignor_id],
    });

    const [product_stores] = await sequelize.query("SELECT * FROM product_stores WHERE consignor_id = ?", {
      replacements: [consignor_id],
    });

    const [rawSales] = await sequelize.query(`
      SELECT s.* 
      FROM sales s
      LEFT JOIN product_stores ps ON s.ps_id = ps.ps_id
      LEFT JOIN products p ON s.product_code = p.product_code AND p.consignor_id = ?
      WHERE ps.consignor_id = ? OR p.consignor_id = ?
    `, {
      replacements: [consignor_id, consignor_id, consignor_id],
    });

    const transactions = [];
    const receiptMap = new Map();

    for (const sale of rawSales) {
      if (sale.receipt_id) {
         if (!receiptMap.has(sale.receipt_id)) {
            receiptMap.set(sale.receipt_id, {
                id: Number(sale.receipt_id) || sale.receipt_id,
                items: [],
                subtotal: 0,
                totalItems: 0,
                paymentMethod: sale.payment_method || "tunai",
                created_at: sale.created_at || sale.sale_date,
            });
         }
         const receipt = receiptMap.get(sale.receipt_id);
         const relatedProduct = products.find(p => p.product_code === sale.product_code);
         receipt.items.push({
             id: Number(sale.product_code) || sale.product_code,
             product_code: sale.product_code,
             nama_produk: relatedProduct?.product_name || "Produk Pilihan",
             harga_jual: Number(sale.quantity_sold) > 0 ? (Number(sale.total_price) / Number(sale.quantity_sold)) : 0,
             qty: Number(sale.quantity_sold),
             kategori: relatedProduct?.category || "Tanpa Kategori"
         });
         receipt.subtotal += Number(sale.total_price);
         receipt.totalItems += Number(sale.quantity_sold);
      } else {
         transactions.push(sale);
      }
    }
    
    for (const [_, receipt] of receiptMap) {
       transactions.push(receipt);
    }

    res.json({
      success: true,
      data: {
        settings,
        products,
        stores,
        product_stores,
        transactions,
      }
    });

  } catch (err) {
    console.error("[SYNC PULL] Error:", err.message);
    res.status(500).json({ success: false, message: "Gagal menarik data sinkronisasi" });
  }
});

module.exports = router;
