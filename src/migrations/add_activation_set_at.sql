-- Migration: Tambah kolom activation_set_at untuk tracking masa aktif kode aktivasi
-- Jalankan via phpMyAdmin atau CLI MySQL

ALTER TABLE `consignors` ADD `activation_set_at` DATETIME NULL DEFAULT NULL AFTER `activation`;
