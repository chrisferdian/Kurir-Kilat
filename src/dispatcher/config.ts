// src/dispatcher/config.ts
// Konfigurasi Environment & Asumsi Internal Dispatcher

export const ENV = {
  SIM_URL: process.env.SIM_URL || "http://localhost:4000",
  API_KEY: process.env.API_KEY || "dev-key",
  PORT: parseInt(process.env.PORT || "3000", 10),
  SEED: process.env.SEED ? parseInt(process.env.SEED, 10) : undefined,
  START_PRACTICE: process.env.START_PRACTICE !== "false",
  STRATEGY: ((process.env.STRATEGY as "greedy" | "insertion") ||
    "insertion") as "greedy" | "insertion",
  HEADLESS: process.env.HEADLESS === "true",
};

export interface DispatchConfig {
  ASSUMED_PATIENCE_TICKS: number;
  ASSUMED_PREMIUM_PATIENCE_TICKS: number;
  ASSUMED_LATE_DECAY_PER_TICK: number;
  ASSUMED_CANCEL_PENALTY_RATE: number;
  TIME_COST_PER_TICK: number;
  MAX_STOPS: number;
  SCORE_POLL_EVERY_TICKS: number;
  SNAPSHOT_EVERY_TICKS: number;
  BLOCK_PAIR_TICKS: number;
  MAX_DECISIONS: number;
}

export const DISPATCH_CONFIG: DispatchConfig = {
  ASSUMED_PATIENCE_TICKS: 40, // Asumsi batas waktu pelanggan reguler menunggu sebelum membatalkan
  ASSUMED_PREMIUM_PATIENCE_TICKS: 30, // Asumsi batas waktu tunggu pelanggan premium yang lebih pendek
  ASSUMED_LATE_DECAY_PER_TICK: 0.05, // Asumsi pemotongan imbalan 5% per tick keterlambatan
  ASSUMED_CANCEL_PENALTY_RATE: 0.5, // Asumsi denda pembatalan 50% dari nilai reward
  TIME_COST_PER_TICK: 50, // Nilai oportunitas per tick waktu kurir untuk evaluasi insertion
  MAX_STOPS: 12, // Batas maksimal stop rute kurir sesuai kontrak spec API
  SCORE_POLL_EVERY_TICKS: 5, // Frekuensi pengambilan data skor dari API kota
  SNAPSHOT_EVERY_TICKS: 10, // Frekuensi penulisan cadangan snapshot ke disk data/
  BLOCK_PAIR_TICKS: 5, // Masa penangguhan penugasan ulang jika pasangan order-kurir ditolak
  MAX_DECISIONS: 500, // Ukuran ring buffer untuk feed log keputusan dispatcher
};

export function loadConfig(overrides?: Partial<DispatchConfig>): DispatchConfig {
  return {
    ...DISPATCH_CONFIG,
    ...overrides,
  };
}
