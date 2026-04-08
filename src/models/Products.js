const { DataTypes } = require("sequelize");
const { sequelize } = require("../config/sequelize");

const Products = sequelize.define(
  "Products",
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    product_code: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    client_ref: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    consignor_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    product_name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    category: {
      type: DataTypes.ENUM("makanan", "minuman", "pakaian", "elektronik"),
      allowNull: true,
    },
    description: {
      type: DataTypes.STRING(250),
      allowNull: true,
    },
    price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      defaultValue: 0,
    },
    stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    unit: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    expiry_date: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    image_path: {
      type: DataTypes.TEXT('long'),
      allowNull: true,
    },
    updated_at: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "products",
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ["product_code", "consignor_id"],
        name: "idx_product_code_consignor_unique",
      },
    ],
  }
);

module.exports = Products;
