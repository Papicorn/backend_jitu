const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Sales = sequelize.define(
  "Sales",
  {
    sale_id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    ps_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    product_code: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    quantity_sold: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    total_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    sale_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    receipt_id: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    payment_method: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    created_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "sales",
    timestamps: false,
  }
);

module.exports = Sales;
