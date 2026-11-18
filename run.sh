#!/usr/bin/env bash
set -e

# Pindah ke root direktori project
cd "$(dirname "$0")"

echo "=========================================="
echo "         KURIR KILAT — RUN SCRIPT         "
echo "=========================================="

# 1. Cek apakah node_modules sudah terpasang
if [ ! -d "node_modules" ]; then
  echo "📦 Dependensi belum terpasang. Menjalankan 'npm install'..."
  npm install
else
  echo "✓ Dependensi (node_modules) sudah siap."
fi

# 2. Jalankan simulator kota + dispatcher + dashboard
echo "🚀 Menjalankan Simulator Kota & Dispatcher..."
echo "🌐 Dashboard akan tersedia di: http://localhost:3000"
echo "Tekan Ctrl+C untuk menghentikan proses yang dimulai oleh perintah ini."
echo "=========================================="

npm start
