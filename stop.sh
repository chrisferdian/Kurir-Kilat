#!/usr/bin/env bash
set -e

echo "=========================================="
echo "        KURIR KILAT — STOP SCRIPT         "
echo "=========================================="

PIDS=$(lsof -ti :3000 -ti :4000 2>/dev/null || true)

if [ -n "$PIDS" ]; then
  echo "🛑 Menghentikan proses di port 3000 & 4000 (PID: $PIDS)..."
  echo "$PIDS" | xargs kill -9 2>/dev/null || true
  echo "✓ Semua proses Kurir Kilat berhasil dimatikan."
else
  echo "✓ Tidak ada proses yang sedang berjalan di port 3000 atau 4000."
fi
echo "=========================================="
