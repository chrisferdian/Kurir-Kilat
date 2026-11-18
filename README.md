# Kurir Kilat — Dispatcher Otomatis & Dashboard Operasional

Program dispatcher otomatis berbasis Node.js dan TypeScript untuk menugaskan pesanan makanan ke armada kurir secara optimal melalui HTTP API kota. Dilengkapi dengan dashboard web real-time (Server-Sent Events + SVG) dan simulator kota lokal yang meniru kontrak API secara penuh.

## Prasyarat
- Node.js versi 20 LTS atau lebih baru.
- npm (bawaan dari instalasi Node.js).

## Cara Cepat (Otomatis Install & Jalankan)
Tersedia script praktis yang otomatis mendeteksi apakah dependensi sudah terpasang, menginstallnya bila belum, membersihkan port lama, dan menjalankan aplikasi:
```bash
./run.sh
```
Untuk menghentikan semua proses di port 3000 dan 4000:
```bash
./stop.sh
```

## Menjalankan Manual
```bash
npm install
npm start
```
Buka browser di: http://localhost:3000

## Menjalankan ke API Kota Asli (Produksi)
Untuk menghubungkan dispatcher ke API kota asli, arahkan `SIM_URL` dan `API_KEY` tanpa perlu mengubah kode sumber:
```bash
SIM_URL=https://api.kotatujuan.com API_KEY=secret-token-asli START_PRACTICE=true npm run dispatcher
```

## Variabel Lingkungan (Environment Variables)

### Dispatcher
| Variabel | Deskripsi | Default |
|---|---|---|
| SIM_URL | URL basis API kota target | http://localhost:4000 |
| API_KEY | Token otentikasi Bearer API kota | dev-key |
| PORT | Port server dashboard operasional | 3000 |
| SEED | Seed acak untuk inisialisasi practice run | (acak) |
| START_PRACTICE | Mulai practice run baru saat inisialisasi (true/false) | true |
| STRATEGY | Algoritma penugasan rute (`insertion` atau `greedy`) | insertion |
| HEADLESS | Mode tanpa dashboard, cetak skor akhir JSON lalu exit | false |

### Simulator Kota
| Variabel | Deskripsi | Default |
|---|---|---|
| SIM_PORT | Port HTTP API server simulator kota | 4000 |
| API_KEY | Kunci rahasia Bearer yang diterima simulator | dev-key |
| TICK_MS | Durasi 1 tick simulasi dalam milidetik nyata | 300 |
| TICKS | Total tick durasi simulasi sebelum selesai | 600 |
| SEED | Seed PRNG Mulberry32 untuk simulasi deterministik | (acak) |

## Pengujian & Tolok Ukur (Benchmark)
- Menjalankan seluruh pengujian unit dan integrasi end-to-end:
  ```bash
  npm test
  ```
- Menjalankan pengecekan tipe statis:
  ```bash
  npm run typecheck
  ```
- Menjalankan benchmark komparasi kinerja algoritma (Greedy vs Insertion):
  ```bash
  npm run bench
  ```

## Struktur File Proyek
```
src/shared/types.ts        Kontrak tipe TypeScript bersama (spec API kota & dashboard snapshot).
src/sim/config.ts          Konfigurasi dan konstanta asumsi kota virtual simulator.
src/sim/rng.ts             PRNG deterministik berbasis algoritma Mulberry32 ber-seed.
src/sim/world.ts           Engine logika simulasi fisik murni tanpa timer/HTTP I/O.
src/sim/server.ts          Server HTTP Express API simulator kota (port 4000).
src/dispatcher/config.ts   Konfigurasi environment dan parameter asumsi dispatcher.
src/dispatcher/client.ts   HTTP client tangguh dengan penanganan retry 429 dan backoff 5xx.
src/dispatcher/planner.ts  Algoritma penugasan rute murni (Greedy & Insertion Heuristic).
src/dispatcher/store.ts    Manajer state in-memory, deduplikasi log, dan snapshot berkala.
src/dispatcher/main.ts     Loop dispatcher otomatis dan server dashboard Express SSE (port 3000).
public/index.html          Antarmuka pengguna dashboard operasional live.
public/style.css           Gaya visual tema gelap responsif dashboard operasional.
public/app.js              Logika client-side dashboard (EventSource SSE, SVG grid, Chart.js).
test/world.test.ts         Unit test engine simulasi World (10 skenario pengetesan).
test/planner.test.ts       Unit test algoritma penugasan rute planner (8 skenario pengetesan).
test/failures.test.ts      Unit test ketahanan kegagalan (retry 429, backoff 5xx, offline, unknown event).
test/dashboard.test.ts     Unit test dashboard SSE stream, snapshot, practice, dan hydration file.
test/e2e.test.ts           Pengujian integrasi end-to-end simulator dan dispatcher headless.
scripts/bench.ts           Script benchmark perbandingan strategi Greedy vs Insertion di 5 seed.
run.sh                     Script otomatisasi install dependensi & start aplikasi.
stop.sh                    Script untuk menghentikan semua proses di port 3000 & 4000.
NOTES.md                   Dokumentasi keputusan arsitektur, trade-off, dan catatan interview.
```

## DEMO

https://github.com/user-attachments/assets/2e283799-c4e4-45e9-bc38-2f1a1dd1a55a




