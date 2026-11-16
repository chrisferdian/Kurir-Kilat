// src/sim/config.ts
// Parameter dan asumsi model dunia kota virtual (Simulator)

export interface SimConfig {
  WIDTH: number;
  HEIGHT: number;
  RESTAURANT_COUNT: number;
  COURIER_COUNT: number;
  COURIER_CAPACITY: number;
  ORDER_RATE: number;
  PREP_MIN: number;
  PREP_MAX: number;
  READY_JITTER_MIN: number;
  READY_JITTER_MAX: number;
  SLACK_MIN: number;
  SLACK_MAX: number;
  BASE_REWARD: number;
  REWARD_PER_CELL: number;
  PREMIUM_CHANCE: number;
  PREMIUM_MULTIPLIER: number;
  PREMIUM_SLACK_REDUCTION: number;
  LATE_DECAY_PER_TICK: number;
  PATIENCE_TICKS: number;
  PREMIUM_PATIENCE_TICKS: number;
  CANCEL_PENALTY_RATE: number;
  WEATHER_CHANGE_EVERY: number;
  WEATHER_CHANGE_CHANCE: number;
  COURIER_OFFLINE_CHANCE: number;
  OFFLINE_MIN: number;
  OFFLINE_MAX: number;
  RATE_LIMIT_PER_SEC: number;
  RATE_LIMIT_BURST: number;
  MAX_STOPS: number;
}

export const SIM_CONFIG: SimConfig = {
  // Dimensi grid kota
  WIDTH: 30, // Lebar grid kota dalam sel
  HEIGHT: 30, // Tinggi grid kota dalam sel

  // Entitas kota
  RESTAURANT_COUNT: 8, // Jumlah restoran yang tersebar di kota
  COURIER_COUNT: 8, // Jumlah kurir dalam armada
  COURIER_CAPACITY: 3, // Kapasitas maksimal pesanan yang dapat dibawa seorang kurir

  // Pola pembuatan pesanan
  ORDER_RATE: 0.3, // Rata-rata pesanan baru per tick (peluang muncul per tick)
  PREP_MIN: 5, // Waktu persiapan makanan minimal (tick)
  PREP_MAX: 15, // Waktu persiapan makanan maksimal (tick)
  READY_JITTER_MIN: -2, // Variasi waktu siap masak asli vs estimasi (minimal)
  READY_JITTER_MAX: 5, // Variasi waktu siap masak asli vs estimasi (maksimal)
  SLACK_MIN: 15, // Kelonggaran waktu deadline minimal (tick)
  SLACK_MAX: 30, // Kelonggaran waktu deadline maksimal (tick)

  // Skema imbalan (reward) dan pesanan premium
  BASE_REWARD: 8000, // Imbalan dasar per pesanan (IDR)
  REWARD_PER_CELL: 500, // Tambahan imbalan per unit jarak Manhattan restoran-dropoff
  PREMIUM_CHANCE: 0.15, // Peluang pesanan berstatus premium (15%)
  PREMIUM_MULTIPLIER: 1.5, // Pengali imbalan untuk pesanan premium
  PREMIUM_SLACK_REDUCTION: 5, // Pengurangan toleransi deadline untuk pesanan premium

  // Denda dan pembatalan
  LATE_DECAY_PER_TICK: 0.05, // Pengurangan payout sebesar 5% per tick keterlambatan
  PATIENCE_TICKS: 45, // Batas waktu tunggu pelanggan reguler sebelum membatalkan (tick)
  PREMIUM_PATIENCE_TICKS: 35, // Batas waktu tunggu pelanggan premium sebelum membatalkan (tick)
  CANCEL_PENALTY_RATE: 0.5, // Penalti pembatalan: 50% dari reward pesanan

  // Kondisi lingkungan & cuaca
  WEATHER_CHANGE_EVERY: 150, // Frekuensi evaluasi perubahan cuaca zona (tiap N tick)
  WEATHER_CHANGE_CHANCE: 0.3, // Peluang cuaca zona berganti (clear <-> rain) saat evaluasi
  COURIER_OFFLINE_CHANCE: 0.002, // Peluang kurir mengalami gangguan/offline per tick (0.2%)
  OFFLINE_MIN: 20, // Durasi kurir offline minimal (tick)
  OFFLINE_MAX: 40, // Durasi kurir offline maksimal (tick)

  // Batasan API
  RATE_LIMIT_PER_SEC: 15, // Batas laju request per detik
  RATE_LIMIT_BURST: 30, // Kapasitas burst token bucket
  MAX_STOPS: 12, // Maksimal jumlah pemberhentian dalam rute kurir
};
