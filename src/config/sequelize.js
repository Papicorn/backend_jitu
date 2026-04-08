const { Sequelize } = require('sequelize');

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: 'mysql',
    logging: false
  }
);

const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log('Sequelize MySQL Connected 🚀'.green);
  } catch (error) {
    console.error('Sequelize connection error:'.red, error);
  }
};

module.exports = { sequelize, connectDB };