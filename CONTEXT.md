# Kurir Kilat — Konteks Project

## Tugas
Tes coding full stack. Bangun:
1. Dispatcher yang otomatis assign order ke kurir lewat HTTP API kota.
2. Dashboard web live (peta, daftar order, panel skor + grafik, log keputusan).
3. Simulator kota palsu dengan API identik (kota asli tidak bisa diakses).
4. NOTES.md + README.md.
Dispatcher harus bisa jalan ke API asli hanya dengan ganti env SIM_URL dan API_KEY, tanpa ubah kode.

## Stack (sudah diputuskan — jangan ganti)
- Node.js 20+, TypeScript, dijalankan langsung dengan `tsx` (tanpa build). `"type": "module"`.
- Import antar file TANPA ekstensi (tsconfig moduleResolution "Bundler").
- Backend: express 4. Tes: vitest. Jalankan bersamaan: concurrently. HTTP client: fetch bawaan Node.
- Frontend: HTML + vanilla JS + SVG, tanpa framework/bundler. Grafik: Chart.js 4.4.1 dari CDN jsdelivr.
- Data ke browser: Server-Sent Events. Tanpa database: state di memori + snapshot JSON di `data/`.

## Struktur file
```
src/shared/types.ts        tipe API + tipe dashboard (kontrak bersama)
src/sim/config.ts          semua asumsi kota (angka bisa diubah)
src/sim/rng.ts             RNG ber-seed (mulberry32)
src/sim/world.ts           logika simulasi murni, tanpa HTTP
src/sim/server.ts          HTTP API meniru spec, port 4000
src/dispatcher/config.ts   config dari env + asumsi dispatcher
src/dispatcher/client.ts   HTTP client ke kota (auth, retry, 429)
src/dispatcher/planner.ts  algoritma dispatch murni (greedy & insertion)
src/dispatcher/store.ts    state memori, log keputusan, snapshot file
src/dispatcher/main.ts     loop dispatcher + server dashboard (port 3000, SSE)
public/index.html, public/style.css, public/app.js   dashboard
test/*.test.ts             vitest
scripts/bench.ts           bandingkan strategi di beberapa seed
```

## Env
Dispatcher: SIM_URL (default http://localhost:4000), API_KEY (default dev-key), PORT (3000),
SEED (opsional), START_PRACTICE (default true), STRATEGY (insertion|greedy, default insertion),
HEADLESS (default false; true = tanpa dashboard, exit saat run selesai, print skor JSON).
Simulator: SIM_PORT (4000), API_KEY (dev-key), TICK_MS (300), TICKS (600), SEED (opsional).

## API kota (spec resmi — simulator meniru persis, dispatcher hanya boleh pakai ini)
Header: `Authorization: Bearer <API_KEY>`, `Content-Type: application/json`.
Error: `{ "error": { "code": "...", "message": "..." } }`. Uang IDR integer. Waktu dalam tick.
Grid (0,0) kiri atas. Kurir gerak 1 sel/tick, horizontal dulu lalu vertikal.

- `GET /v1/map` → `{ width, height, restaurants:[{id,x,y}], zones:[{name,x0,y0,x1,y1,weather}] }`
- `POST /v1/practice` body `{seed?}` → `{ run_id, seed, ticks, tick_ms }`. Mengganti run yang berjalan.
- `GET /v1/state` → `{ run:{id,mode,status,tick,ticks,tick_ms}, couriers:[{id,x,y,capacity,status,carrying:[orderId],route:[{order_id,action}]}], orders:[{id,restaurant:{id,x,y},dropoff:{x,y},created_tick,estimated_ready_tick,deadline_tick,reward,premium,status,courier_id}] }`
  - status kurir: idle, moving, waiting, … (bisa ada nilai lain)
  - status order: OPEN (belum ada kurir), ASSIGNED, PICKED_UP. Order selesai hilang dari state.
- `PUT /v1/couriers/:id/route` body `{stops:[{order_id, action:"pickup"|"dropoff"}]}` → courier yang diperbarui.
  MENGGANTI sisa rute. Pickup harus diikuti dropoff order yang sama di rute yang sama. Order yang sedang
  dibawa wajib punya dropoff. Tidak boleh melebihi capacity. Maks 12 stop. Order yang sebelumnya
  direncanakan untuk kurir ini tapi tidak ada di rute baru → kembali OPEN.
  Error: order_taken, capacity_exceeded, invalid_dropoff (dan mungkin lainnya).
- `GET /v1/events?after=<cursor>&limit=<1-200>` → `{ data:[{seq,tick,type,data}], next_cursor, has_more }`
  Tipe: run.started, order.created, order.picked_up, order.delivered, order.cancelled, run.finished. Tipe lain bisa muncul.
- `GET /v1/score` → `{ delivered, cancelled, revenue, penalties, total }`
- Reward penuh jika diantar ≤ deadline_tick, telat dibayar lebih kecil. Pelanggan bisa cancel kalau terlalu lama
  belum di-pickup (merugikan). Jumlah request harus wajar (bisa kena 429).

## Asumsi kota KITA (tidak ada di spec; semua di src/sim/config.ts)
- Grid 30×30, 8 restoran, 4 zona kuadran (barat-laut, timur-laut, barat-daya, tenggara), 8 kurir capacity 3.
- ORDER_RATE 0.3 order/tick. Siap masak: estimated_ready = created + rand(5..15); ready asli = estimated + rand(-2..+5) (rahasia).
- deadline = estimated_ready + jarak(restoran→antar) + rand(15..30). reward = 8000 + 500×jarak, dibulatkan ke 500.
- Premium 15%: reward ×1.5, slack deadline -5, sabar lebih pendek.
- Telat: payout = reward × max(0, 1 − 0.05 × tick_telat). Tidak ada denda telat.
- Cancel: order OPEN/ASSIGNED belum di-pickup setelah created + 45 tick (premium 35) → batal, denda 50% reward.
- Hujan: kurir di zona hujan hanya bergerak di tick genap. Cuaca tiap zona bisa berubah tiap 150 tick → event `zone.weather_changed`.
- Kurir hilang: peluang 0.002/tick/kurir hilang dari state selama 20–40 tick (event `courier.offline`/`courier.online`);
  order ASSIGNED-nya kembali OPEN, order yang dibawa tetap PICKED_UP.
- Rate limit: 15 req/detik, burst 30 → 429 + header Retry-After.
- Sim juga mengirim event `courier.route_updated` (sengaja, untuk menguji penanganan tipe event tak dikenal).
