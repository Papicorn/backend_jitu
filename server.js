require('dotenv').config();
require('colors');

const app = require('./src/app');
const { connectDB } = require('./src/config/sequelize');

const PORT = process.env.PORT || 5000;

const start = async () => {
  await connectDB();
  const { sequelize } = require('./src/config/sequelize');
  await sequelize.sync({ alter: true });
  console.log('Database synced with alter: true'.cyan);

  const HOST = '0.0.0.0';
  app.listen(PORT, HOST, () => {
    console.log(`Server jalan di http://localhost:${PORT} (dan http://${require('os').networkInterfaces()['Wi-Fi']?.[1]?.address || 'IP-Host'}:${PORT})`.yellow);
  });
};

start().catch(err => {
  console.error('Server gagal start:', err);
});