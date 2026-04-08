const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/sequelize');

const DeviceActivation = sequelize.define('DeviceActivation', {
  id: {
    type: DataTypes.INTEGER,
    autoIncrement: true,
    primaryKey: true
  },
  consignor_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  device_id: {
    type: DataTypes.STRING(64),
    allowNull: false
  },
  device_name: {
    type: DataTypes.STRING(100),
    allowNull: true,
    defaultValue: null
  },
  activated_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  },
  last_used_at: {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: DataTypes.NOW
  }
}, {
  tableName: 'device_activations',
  timestamps: false,
  indexes: [
    {
      unique: true,
      fields: ['consignor_id', 'device_id']
    }
  ]
});

module.exports = DeviceActivation;
