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

# 2. Bersihkan port 3000 & 4000 jika ada proses lama yang menggantung
PIDS=$(lsof -ti :3000 -ti :4000 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "🧹 Membersihkan proses lama di port 3000/4000 (PID: $PIDS)..."
  echo "$PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# 3. Jalankan simulator kota + dispatcher + dashboard
echo "🚀 Menjalankan Simulator Kota & Dispatcher..."
echo "🌐 Dashboard akan tersedia di: http://localhost:3000"
echo "Tekan Ctrl+C atau jalankan './stop.sh' untuk menghentikan."
echo "=========================================="

npm start
