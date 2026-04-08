const { Sequelize } = require('sequelize');

// Ambil kredensial dari lingkungan atau hardcode sesuai .env yang saya lihat tadi
const sequelize = new Sequelize('jitu', 'root', '', {
  host: 'localhost',
  dialect: 'mysql',
  logging: false
});

async function runMigration() {
  console.log('--- Memulai Migrasi Kolom Kerugian ---');
  try {
    await sequelize.authenticate();
    console.log('✅ Terhubung ke Database.');

    const columns = [
      { name: 'loss_amount', type: 'DECIMAL(10,2) DEFAULT 0' },
      { name: 'loss_quantity', type: 'INTEGER DEFAULT 0' },
      { name: 'remaining_stock_action', type: 'VARCHAR(50) DEFAULT NULL' }
    ];

    for (const col of columns) {
      try {
        await sequelize.query(`ALTER TABLE product_stores ADD COLUMN ${col.name} ${col.type}`);
        console.log(`✅ Kolom ${col.name} berhasil ditambahkan.`);
      } catch (err) {
        if (err.message.includes('Duplicate column name')) {
          console.log(`ℹ️ Kolom ${col.name} sudah ada.`);
        } else {
          console.error(`❌ Gagal menambah kolom ${col.name}:`, err.message);
        }
      }
    }

    console.log('--- Migrasi Selesai ---');
  } catch (err) {
    console.error('❌ Koneksi database gagal:', err.message);
  } finally {
    await sequelize.close();
    process.exit();
  }
}

runMigration();
