const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/sequelize');
const bcrypt = require('bcrypt');

const Consignors = sequelize.define('Consignors', {
  consignor_id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  full_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  email: {
    type: DataTypes.STRING,
  },
  phone: {
    type: DataTypes.STRING,
  },
  password: {
    type: DataTypes.STRING,
    allowNull: false
  },
  store_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  profile_photo: {
    type: DataTypes.TEXT('long'),
    allowNull: true
  },
  role: {
    type: DataTypes.STRING,
    allowNull: true
  },
  total_capital: {
    type: DataTypes.DECIMAL(10,2),
    allowNull: false
  },
  last_login: {
    type: DataTypes.DATE,
    allowNull: false
  },
  activation: {
    type: DataTypes.STRING(256),
    allowNull: true,
    defaultValue: null
  },
  activation_set_at: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null
  }
}, {
  tableName: 'consignors',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['email'],
      name: 'email_unique_index'
    },
    {
      unique: true,
      fields: ['phone'],
      name: 'phone_unique_index'
    }
  ]
});

module.exports = Consignors;