# Catatan Teknis & Keputusan Desain: Kurir Kilat

Dokumen ini menjelaskan seluruh keputusan arsitektural, trade-off teknis, asumsi model kota, analisis kegagalan, dan hasil benchmark empiris untuk sistem **Kurir Kilat — Dispatcher**.

---

## 1. Pilihan Teknologi & Alasannya

| Komponen | Pilihan | Alasan & Trade-off |
|---|---|---|
| **Runtime & Bahasa** | **Node.js 20+ & TypeScript** | Menawarkan ekosistem asynchronous non-blocking I/O yang ideal untuk server event-driven, pengetikan statis yang ketat untuk mencegah bug kontrak API, dan tooling modern. |
| **Eksekusi TS** | **tsx (tanpa build step)** | Mengeliminasi kebutuhan konfigurasi build yang rapuh (webpack, tsup, tsc build) dan kompilasi manual. Penguji dapat menjalankan kode langsung dengan cepat dan deterministik. |
| **Backend & Dashboard** | **Express 4** | Sangat stabil, minim overhead, dan mudah dikonfigurasi untuk menyajikan Server-Sent Events (SSE) dan static assets tanpa framework bloating. |
| **Testing** | **Vitest** | Kompatibel native dengan ESM dan TypeScript modern, startup secepat kilat (sub-detik), dan memiliki test runner ergonomis. |
| **Frontend UI** | **Vanilla HTML, CSS, JS + SVG** | **0 kB build bundle**. Tidak ada dependensi React/Vue/Vite di sisi client. Browser langsung merender DOM dan SVG native secara instan tanpa proses kompilasi frontend. |
| **Visualisasi Grafik** | **Chart.js 4.4.1 (CDN)** | Sangat matang, ringan, dan mendukung pembaruan data real-time dengan mode `update("none")` tanpa drop frame. |

---

## 2. Arsitektur: Dispatcher & Dashboard vs Simulator

### Mengapa Dispatcher & Dashboard Digabung dalam 1 Proses?
1. **Zero IPC / Zero Broker Latency:** State in-memory di dispatcher (`Store`) dapat langsung dibagikan ke server HTTP SSE tanpa membutuhkan Redis, message broker, atau Unix socket IPC tambahan.
2. **Kemudahan Operasional:** Operator hanya perlu menyalakan satu proses untuk menjalankan seluruh sistem dispatching sekaligus memantau antarmuka web.
3. **Efisiensi Memori:** Tidak ada duplikasi cache state antara dispatcher dan backend dashboard.

### Mengapa Simulator Kota Dipisah sebagai Proses/Service HTTP Terpisah?
1. **Kemandirian (Black-Box Isolation):** Simulator berjalan di port 4000 independen. Kode dispatcher sama sekali tidak boleh mengakses instance memori atau class internal simulator.
2. **Verifikasi Plug-and-Play ke Kota Asli:** Memastikan bahwa dispatcher benar-benar siap beralih ke server produksi kota asli hanya dengan mengganti environment variable `SIM_URL` dan `API_KEY`.

---

## 3. Mengetes Tanpa Kota Asli (Simulator Kota)

### Mengapa Membangun Simulator HTTP Sendiri?
Tanpa akses ke API kota produksi, menggunakan mock statis (mocking fetch) hanya menguji logika parser, tetapi gagal menguji interaksi dinamis seperti antrean pergerakan kurir, penumpukan pesanan, perubahan rute yang saling mendahului, pembatalan akibat keterlambatan, dan rate limiting.

### Seberapa Mirip Simulator dengan Kota Asli?
- **Sangat Mirip:**
  - Kontrak HTTP, header Authorization Bearer, struktur JSON request/response, dan format error `{ error: { code, message } }` identik 100% dengan spesifikasi.
  - Aturan grid (0,0) di kiri atas, pergerakan 1 sel/tick (horizontal dulu baru vertikal).
  - Validasi ketat `PUT /v1/couriers/:id/route`: pembatasan 12 stop, validasi muatan $\le$ capacity, keharusan menyertakan dropoff untuk pesanan yang sedang dibawa, dan penolakan pesanan yang sudah diambil kurir lain (`order_taken`).
  - Mekanisme token-bucket rate limiter (15 req/detik, burst 30) dengan status 429 dan header `Retry-After`.
- **Apa yang Tidak Ditiru (Asumsi Tambahan):**
  - Kota asli merahasiakan waktu siap masak sebenarnya. Simulator kita memodelkan ini dengan *jitter* acak ($[-2, +5]$ tick) terhadap estimasi awal untuk menguji apakah kurir mau menunggu di restoran saat tiba terlalu cepat.
  - Simulator menambahkan dinamika cuaca hujan lokal per zona (memperlambat kurir di tick ganjil) dan kurir offline mendadak (20–40 tick) untuk menguji penugasan ulang otomatis.

---

## 4. Strategi Pengambilan Data: Polling `/v1/state` vs Event Feed `/v1/events`

Dispatcher menerapkan **pendekatan hibrida terkoordinasi**:

1. **Polling `/v1/state` Setiap Tick:**
   - Berfungsi sebagai **Ground Truth**. State menyediakan snapshot posisi fisik aktual kurir $(x, y)$, status kurir (`idle`, `moving`, `waiting`), dan daftar pesanan yang sedang terbuka/dibawa.
   - Konsekuensi: State tidak menyimpan pesanan yang sudah selesai atau dibatalkan (pesanan selesai langsung hilang dari array state).
2. **Kuras Habis `/v1/events` (Drain Loop) Setiap Tick:**
   - Berfungsi sebagai **State Transition Capture**. Dipanggil dengan paginasi (`has_more`) hingga semua event terserap.
   - Menangkap mutasi krusial: pembayaran order yang terantar (`order.delivered` + payout aktual), denda pelanggan yang membatalkan pesanan (`order.cancelled` + penalty), perubahan cuaca zona (`zone.weather_changed`), dan kurir offline.
3. **Konsekuensi & Sinergi:**
   - Jika hanya polling state: Kita kehilangan riwayat pendapatan, denda, dan alasan kenapa suatu pesanan mendadak hilang.
   - Jika hanya mengandalkan event feed: Rentan mengalami *drift* desinkronisasi jika ada event yang terlewat atau jika sistem dispatcher mengalami restart di tengah jalan.
   - Dengan menggabungkan keduanya: State menjamin integritas koordinat, sementara event feed menjamin integritas finansial dan riwayat audit.

---

## 5. Aliran Data ke Browser: Server-Sent Events (SSE)

### Mengapa SSE Bukan Polling atau WebSocket?
- **Dibandingkan Polling Browser:** Polling setiap 300ms dari browser menimbulkan overhead HTTP handshake dan header berulang yang boros bandwidth serta membebani event loop Express.
- **Dibandingkan WebSocket:** Dashboard hanya membutuhkan aliran data **satu arah** (server ke browser). WebSocket memerlukan implementasi protokol dua arah, upgrade handshake, ping-pong heartbeat manual, dan penanganan reconnection yang lebih rumit.
- **Keunggulan SSE:**
  - Protokol standar berbasis HTTP biasa (`text/event-stream`), ramah proxy/firewall.
  - Browser memiliki API bawaan `EventSource` dengan **native auto-reconnect**.

### Penanganan Koneksi Browser Terputus
1. Klien browser mendeteksi putusnya koneksi melalui event `onerror` pada `EventSource`, seketika mengubah badge status di header menjadi merah *"Terputus, mencoba lagi…"*.
2. Browser secara otomatis mencoba rekoneksi dengan jeda 2 detik (dikonfigurasi via directive `retry: 2000`).
3. Begitu tersambung kembali (`onopen`), server Express **langsung mengirimkan full snapshot terbaru** (`event: snapshot`), sehingga visualisasi peta, skor, dan tabel pesanan seketika ter-sinkronisasi tanpa ada data yang tertinggal.

---

## 6. Frontend: Vanilla JS + SVG yang Ringan

1. **Mengapa SVG Bukan Canvas?**
   - Grid kota berukuran 30×30 sel (total 900 sel). Pada skala ini, SVG jauh lebih superior daripada HTML5 Canvas:
     - SVG adalah bagian dari DOM: setiap elemen kurir dan pesanan dapat diberi atribut ID, kelas CSS, dan tooltip native `<title>` untuk interaktivitas instan tanpa perlu perhitungan *hit-testing* koordinat piksel manual seperti di Canvas.
     - Styling visual (warna status, opacity, garis putus-putus rute) dikontrol melalui CSS modern.
2. **Bagaimana Menjaga UI Tetap Ringan (60 FPS)?**
   - **Layering Terpisah pada SVG:**
     - `<g id="layer-static">`: Zona dan restoran di-cache; hanya dirender ulang jika cuaca berubah.
     - `<g id="layer-routes">`: Polyline kurir dengan sudut siku-siku (horizontal dulu lalu vertikal).
     - `<g id="layer-dynamic">`: Kurir dan titik antar pesanan.
   - **DOM Pooling & Reuse (Tanpa `innerHTML` Reset):**
     - Memanfaatkan `Map<id, SVGElement>` dan `Map<id, HTMLTableRowElement>` untuk mendaur ulang elemen DOM yang sudah ada, hanya memperbarui atribut `transform` koordinat dan teks status.
   - **Throttling via `requestAnimationFrame`:**
     - Re-render visual dijadwalkan maksimal 1 kali per refresh rate monitor, mencegah bottleneck rendering meskipun simulasi dipercepat pada `TICK_MS=50`.
   - **Chart.js Tanpa Animasi Jitter:**
     - Memperbarui dataset grafik menggunakan `scoreChart.update("none")` agar grafik diperbarui tanpa lag transisi animasi.

---

## 7. State Memori & Penanganan Restart di Tengah Run

### Apa yang Disimpan di Memori (`Store`)?
- State aktif run saat ini (`runId`, `tick`, posisi kurir, status pesanan).
- Ring buffer log keputusan dispatcher (maksimal 500 entri terakhir) dengan auto-deduplikasi pesan skip.
- Daftar riwayat pesanan selesai/batal (maksimal 300 entri).
- Riwayat perkembangan skor berkala (`ScorePoint[]`).
- Kursor sekuens event (`eventCursor`) untuk melanjutkan kuras stream event.

### Apa yang Terjadi Jika Program Restart di Tengah Run?
- Dispatcher memiliki persistensi cadangan berkala ke disk: `data/snapshot-<runId>.json` setiap 10 tick.
- Saat dinyalakan kembali dengan `START_PRACTICE=false`:
  1. Dispatcher menanyakan `GET /v1/state` untuk mendapatkan `run_id` kota yang sedang berjalan.
  2. Dispatcher memeriksa apakah ada file snapshot yang cocok di `data/`.
  3. Jika ditemukan, `eventCursor`, log keputusan, dan riwayat finansial langsung di-*hydrate* kembali ke memori.
  4. Dispatcher melanjutkan kuras event dari `eventCursor` terakhir tanpa mengulang log dari nol dan tanpa kehilangan jejak skor lama.

---

## 8. Algoritma Dispatch: Greedy vs Insertion Heuristic

### A. Greedy Strategy (Baseline Pembanding)
- Mengurutkan pesanan `OPEN` (prioritas premium, lalu deadline terdekat).
- Memilih kurir terdekat dari restoran pesanan (yang masih memiliki slot kapasitas kosong) dan menempelkan `[pickup, dropoff]` di ujung akhir rute kurir.
- **Kelemahan:** Mengabaikan rute perjalanan kurir yang sudah ada. Seringkali kurir yang sedang menuju ke arah yang sama dilewati begitu saja karena kurir lain yang sedang menganggur sedikit lebih dekat ke restoran, menghasilkan rute zig-zag yang tidak efisien dan menyebabkan banyak pesanan lain terlambat (*deadline expired*).

### B. Insertion Heuristic (Strategi Utama Terpilih)
- Mencoba seluruh kemungkinan kombinasi penempatan pickup di indeks $i$ dan dropoff di indeks $j > i$ pada rute kerja kurir aktif.
- Menghitung **Marginal Profit ($\Delta$)**:
  $$\Delta = \text{Value}_{\text{baru}} - \text{Value}_{\text{lama}} - (\text{TIME\_COST\_PER\_TICK} \times \Delta_{\text{waktu}})$$
  di mana $\text{Value}$ mengkalkulasi imbalan penuh jika dropoff $\le$ deadline, depresiasi 5%/tick jika terlambat, dan estimasi denda pembatalan jika waktu tunggu pickup melampaui batas toleransi pelanggan.
- **Kalkulasi Akurat untuk Order Batal:** Jika perkiraan waktu pickup melewati batas toleransi pelanggan (`eta.pickup > created_tick + patience`), pesanan dipastikan batal sebelum sempat diambil kurir. Maka imbalan *payout* bernilai 0 dan sistem hanya menanggung denda pembatalan (`0 - cancelPenalty`). Hal ini mencegah planner bersikap terlalu optimis.
- **Kebijakan Order ASSIGNED:** Order yang sudah berstatus `ASSIGNED` ke kurir tertentu tidak dipindahkan ke kurir lain. Mengapa? Karena API kota secara tegas melempar HTTP 409 `order_taken` jika kurir B mencoba mengambil order yang masih ditugaskan ke kurir A. Memindahkan pesanan membutuhkan transaksi multi-tahap (lepas dari kurir A $\rightarrow$ tunggu state kembali `OPEN` $\rightarrow$ assign ke kurir B). Di tengah batas laju request 15 req/s dan durasi tick 300ms yang cepat, transaksi multi-tahap ini sangat rentan kegagalan *race condition*. Oleh karena itu, kurir yang telah di-assign tetap mengoptimalkan urutan stop-nya sendiri, dan penugasan ulang lintas kurir hanya terjadi saat kurir mengalami gangguan offline.
- **Keunggulan:** Secara alami membentuk **batching rute searah**. Jika kurir sedang mengantar pesanan ke arah timur dan ada pesanan baru yang restoran serta dropoff-nya berada di sepanjang koridor tersebut, algoritma akan menyisipkannya di tengah perjalanan kurir tanpa membuang banyak waktu tambahan.

### Hasil Uji Benchmark Empiris (5 Seeds, 600 Ticks)
Berikut adalah hasil pengujian langsung menggunakan `npm run bench` (`scripts/bench.ts`):

| Seed | Strategi | Delivered | Cancelled | Revenue (IDR) | Penalties (IDR) | Total Laba (IDR) |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 1 | greedy | 85 | 79 | Rp 1.233.400 | Rp 800.000 | Rp 433.400 |
| 2 | greedy | 74 | 88 | Rp 808.500 | Rp 858.000 | -Rp 49.500 |
| 3 | greedy | 70 | 100 | Rp 861.525 | Rp 968.500 | -Rp 106.975 |
| 4 | greedy | 80 | 84 | Rp 1.073.250 | Rp 865.750 | Rp 207.500 |
| 5 | greedy | 88 | 68 | Rp 1.212.975 | Rp 661.000 | Rp 551.975 |
| **Rata-rata** | **greedy** | **79.4** | **83.8** | **Rp 1.037.930** | **Rp 830.650** | **Rp 207.280** |
| 1 | insertion | 135 | 22 | Rp 1.860.175 | Rp 207.500 | Rp 1.652.675 |
| 2 | insertion | 123 | 38 | Rp 1.244.900 | Rp 384.500 | Rp 860.400 |
| 3 | insertion | 100 | 55 | Rp 1.070.925 | Rp 501.750 | Rp 569.175 |
| 4 | insertion | 121 | 32 | Rp 1.532.425 | Rp 329.250 | Rp 1.203.175 |
| 5 | insertion | 137 | 12 | Rp 1.926.450 | Rp 118.250 | Rp 1.808.200 |
| **Rata-rata** | **insertion** | **123.2** | **31.8** | **Rp 1.526.975** | **Rp 308.250** | **Rp 1.218.725** |

### Analisis Hasil:
- **Peningkatan Laba Bersih:** Strategi **Insertion menghasilkan laba rata-rata Rp 1.218.725**, yaitu **+488.0% (hampir 6x lipat)** dibandingkan strategi Greedy (Rp 207.280).
- **Efisiensi Pengantaran:** Insertion sukses mengantar rata-rata **123.2 pesanan (+55.2%)**, sementara Greedy hanya mengantar 79.4 pesanan.
- **Pencegahan Denda Pembatalan:** Insertion memangkas jumlah pembatalan pesanan dari 83.8 menjadi 31.8 pesanan (**penurunan drastis -62.1%**), menghemat denda penalti sebesar Rp 522.400 per run.

---

## 9. Penanganan Kegagalan (Failure Handling)

1. **Rate Limit HTTP 429:**
   - Client membaca header `Retry-After` (detik) dari respons 429 server kota, menidurkan proses client selama durasi tersebut, lalu melakukan retry otomatis maksimal 3 kali.
2. **Penolakan Pembaruan Rute (Route Rejected):**
   - Jika server kota menolak rute dengan HTTP 4xx (misal: `capacity_exceeded`, `order_taken`, atau `invalid_dropoff` akibat *race condition* pergerakan), client **tidak melempar exception fatal**.
   - Pasangan order dan kurir terkait dimasukkan ke dalam daftar *blacklist* sementara (`blocked` set) selama 5 tick (`BLOCK_PAIR_TICKS`), mencegah dispatcher terjebak dalam perulangan pengiriman rute yang sama secara sia-sia.
3. **Tipe Event yang Tidak Dikenal:**
   - Dispatcher membaca spesifikasi terbuka: event feed dapat memunculkan tipe baru di masa mendatang.
   - Jika tipe event asing terdeteksi (seperti `courier.route_updated`), dispatcher mencatat log informatif satu kali (`unknownEventTypesSeen`) dan mengabaikannya dengan aman tanpa melempar crash.
4. **Kurir Hilang / Gangguan Koneksi Kurir:**
   - Jika kurir tiba-tiba tidak muncul di array `couriers` pada respon state kota, dispatcher mendeteksinya sebagai kurir offline.
   - Pesanan berstatus `ASSIGNED` yang belum diambil dilepaskan kembali ke status `OPEN` agar dapat segera dialihkan ke kurir lain yang aktif.

---

## 10. Asumsi Model Kota Virtual (Simulator)

| Parameter | Nilai | Alasan / Justifikasi Bisnis |
|---|---|---|
| `WIDTH`, `HEIGHT` | 30 × 30 | Sesuai spesifikasi resmi grid kota kecil. |
| `RESTAURANT_COUNT` | 8 | Cukup untuk membentuk klaster pesanan yang realistis di kota kecil. |
| `COURIER_COUNT` | 8 | Rasio seimbang (1 kurir per restoran secara rata-rata). |
| `COURIER_CAPACITY` | 3 | Standar kapasitas tas motor kurir makanan on-demand. |
| `ORDER_RATE` | 0.3 / tick | Menghasilkan ~180 pesanan dalam 600 tick, memberikan beban kerja optimal pada armada. |
| `PREP_MIN`, `PREP_MAX` | 5 – 15 tick | Waktu penyiapan makanan di dapur restoran sebelum siap di-pickup. |
| `READY_JITTER` | -2 s/d +5 tick | Variasi ketidakpastian dapur nyata yang dirahasiakan simulator. |
| `SLACK_MIN`, `SLACK_MAX` | 15 – 30 tick | Kelonggaran waktu perjalanan wajar agar kurir tidak selalu terlambat. |
| `BASE_REWARD` | Rp 8.000 | Tarif dasar pengantaran makanan. |
| `REWARD_PER_CELL` | Rp 500 / sel | Kompensasi berbasis jarak tempuh Manhattan. |
| `PREMIUM_CHANCE` | 0.15 (15%) | Proporsi pelanggan prioritas yang membayar tarif lebih mahal. |
| `PREMIUM_MULTIPLIER` | 1.5x | Tambahan imbalan bagi pesanan prioritas. |
| `LATE_DECAY_PER_TICK` | 0.05 (5%) | Pemotongan imbalan bertahap bila terlambat (hangus setelah 20 tick telat). |
| `PATIENCE_TICKS` | 45 tick (reguler), 35 tick (premium) | Batas kesabaran pelanggan sebelum membatalkan pesanan. |
| `CANCEL_PENALTY_RATE` | 0.5 (50%) | Penalti kerugian biaya masak dan kompensasi pelanggan jika batal. |
| `WEATHER_CHANGE_EVERY` | 150 tick | Frekuensi perubahan iklim per kuadran zona. |
| `COURIER_OFFLINE_CHANCE` | 0.002 / tick | Peluang realistis kurir mengalami kendala operasional (ban bocor, sinyal hilang). |

---

## 11. Status Pengujian: Apa yang Sudah & Belum Dites

### Sudah Dites Secara Komprehensif (30 Test Cases Lolos):
- **Unit Test Engine Simulasi (`test/world.test.ts` - 10 Test):**
  - Pergerakan sel ortogonal horizontal dulu baru vertikal.
  - Perilaku kurir menunggu masakan matang (`waiting`) dan pembayaran imbalan tepat waktu.
  - Penurunan pembayaran proporsional saat pengantaran terlambat.
  - Pembatalan pesanan otomatis saat melewati batas toleransi pelanggan beserta pemotongan penalti.
  - Penolakan validasi rute: `capacity_exceeded`, `too_many_stops`, `order_taken`, `invalid_dropoff`, `courier_not_found`.
  - Pemulihan pesanan yang dibatalkan rutenya kembali ke status `OPEN`.
  - Paginasi kursor event feed dan mekanisme penghentian run pada batas tick.
  - Determinisme seed PRNG (seed yang sama menghasilkan state yang identik 100%).
- **Unit Test Algoritma Perencanaan (`test/planner.test.ts` - 8 Test):**
  - Simulasi rute, kalkulasi ETA, deteksi rute tidak layak (*infeasible*).
  - Algoritma Insertion memilih kurir dengan penambahan waktu paling minimal.
  - Pembentukan *batching* alami pada pesanan yang berada di koridor searah.
  - Jaminan tidak pernah melanggar batas kapasitas muatan dan 12 stop pada 30 pesanan acak.
  - Kepatuhan terhadap daftar blokir sementara (`blocked` set).
  - Algoritma Greedy memilih kurir terdekat.
- **Unit Test Ketahanan Kegagalan (`test/failures.test.ts` - 6 Test):**
  - Penanganan rate limit HTTP 429 berdasar header `Retry-After` dengan retry otomatis pada client.
  - Penanganan server error HTTP 5xx dengan exponential backoff bertahap.
  - Toleransi non-fatal error HTTP 4xx pada `putRoute()` tanpa melempar exception crash.
  - Penanganan tipe event tak dikenal (seperti `courier.route_updated`) yang diabaikan dan dicatat log-nya tepat 1 kali.
  - Deteksi kurir offline, pembersihan seketika blokir rute kurir terkait, dan pemulihan saat kurir online kembali.
  - Preservasi data pesanan selesai/batal secara utuh (restoran, koordinat, reward asli) tanpa *fallback unknown*.
- **Unit Test Dashboard & Hydration (`test/dashboard.test.ts` - 4 Test):**
  - Endpoint `GET /api/snapshot` menyajikan data operasional lengkap.
  - Stream Server-Sent Events `GET /api/stream` mengirimkan header `text/event-stream`, direktif `retry: 2000`, dan snapshot pertama.
  - Endpoint `POST /api/practice` memicu inisialisasi practice run baru.
  - Mekanisme persistensi `Store.save()` dan `Store.load()` memulihkan kursor event dan log riwayat saat restart (`START_PRACTICE=false`).
- **Integrasi End-to-End (`test/e2e.test.ts` - 2 Test):**
  - Eksekusi headless penuh 300 tick antara simulator HTTP nyata dan dispatcher mandiri.
  - Respon kegagalan otentikasi seketika saat API_KEY salah tanpa proses menggantung (*no hanging*).

### Belum Dites / Potensi Skenario Ekstrem:
- Simulasi koneksi jaringan fisik yang mengalami *packet loss* parah atau *intermittent jitter*.
- Pengetesan beban ekstrem dengan 500 kurir dan ribuan pesanan aktif secara konkuren.

---

## 12. Skalabilitas: Apa yang Diubah Jika Order Naik 10× & Kurir Bertambah?

Jika skala sistem diperbesar hingga **10× lipat** (80 kurir, ribuan order aktif per run):

1. **Optimasi Algoritma Insertion (Spatial Partitioning / KD-Tree):**
   - Saat ini, insertion mengevaluasi seluruh kurir untuk setiap order $O(M \times N \times S^2)$.
   - Pada skala 10×, kita dapat menerapkan pemisahan spasial (grid indexing / quadtree) untuk hanya menguji 5 kurir terdekat dari klaster restoran terkait, memangkas kompleksitas komputasi menjadi $O(K \times S^2)$ di mana $K \ll M$.
2. **Delta Diff Streaming untuk Dashboard (Bukan Full Snapshot):**
   - Saat ini dashboard menerima snapshot penuh tiap tick (~30 kB). Pada ribuan pesanan, ukuran JSON snapshot bisa membengkak menjadi beberapa megabyte.
   - Solusi: Beralih ke format **JSON Patch / Diff Stream**, di mana server hanya mengirimkan entitas yang posisinya berubah atau pesanan yang mengalami transisi status.
3. **Database Persistensi & Arsitektur Terdistribusi:**
   - Memisahkan store in-memory ke distributed cache (Redis) dan database event-store (PostgreSQL / SQLite) untuk audit jangka panjang dan failover multi-instance dispatcher.
