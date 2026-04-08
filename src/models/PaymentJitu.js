const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/sequelize');

const PaymentJitu = sequelize.define('PaymentJitu', {
  id_payment: {
    type: DataTypes.STRING(25),
    primaryKey: true
  },
  whatsapp: {
    type: DataTypes.STRING(14),
    allowNull: false
  },
  full_name: {
    type: DataTypes.STRING(50),
    allowNull: false
  },
  umkm: {
    type: DataTypes.STRING(80),
    allowNull: false
  },
  unique_num: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  status: {
    type: DataTypes.ENUM('success', 'pending'),
    allowNull: false,
    defaultValue: 'pending'
  },
  plan: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  is_processed: {
    type: DataTypes.BOOLEAN,
    defaultValue: 0
  },
  created_at: {
    type: DataTypes.DATE,
    allowNull: false
  },
  updated_at: {
    type: DataTypes.DATE,
    allowNull: false
  }
}, {
  tableName: 'payment_jitu',
  timestamps: true,
  createdAt: 'created_at',
  updatedAt: 'updated_at'
});

module.exports = PaymentJitu;
