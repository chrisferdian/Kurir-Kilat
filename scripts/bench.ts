// scripts/bench.ts
// Benchmark Komparasi Kinerja Algoritma Dispatch (Greedy vs Insertion)

import { runDispatcher } from "../src/dispatcher/main";
import { startSimServer } from "../src/sim/server";

interface BenchResult {
  seed: number;
  strategy: "greedy" | "insertion";
  delivered: number;
  cancelled: number;
  revenue: number;
  penalties: number;
  total: number;
}

const SEEDS = [1, 2, 3, 4, 5];
const STRATEGIES: ("greedy" | "insertion")[] = ["greedy", "insertion"];

const rupiah = (val: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(val);

async function runSingleBench(
  seed: number,
  strategy: "greedy" | "insertion"
): Promise<BenchResult> {
  const apiKey = `bench-${strategy}-${seed}`;
  const sim = await startSimServer({
    port: 0,
    apiKey,
    tickMs: 5,
    ticks: 600,
    seed,
  });

  try {
    const score = await runDispatcher({
      env: {
        SIM_URL: sim.url,
        API_KEY: apiKey,
        START_PRACTICE: true,
        ALLOW_PRACTICE: false,
        SEED: seed,
        HEADLESS: true,
        STRATEGY: strategy,
        PORT: 0,
      },
    });

    return {
      seed,
      strategy,
      delivered: score.delivered,
      cancelled: score.cancelled,
      revenue: score.revenue,
      penalties: score.penalties,
      total: score.total,
    };
  } finally {
    await sim.close();
  }
}

async function main() {
  console.log("==========================================================================");
  console.log("  BENCHMARK ALGORITMA DISPATCHER KURIR KILAT (600 Ticks per Run, 5 Seeds)");
  console.log("==========================================================================\n");

  const results: BenchResult[] = [];

  for (const strategy of STRATEGIES) {
    for (const seed of SEEDS) {
      process.stdout.write(`Menjalankan [${strategy.toUpperCase()}] Seed ${seed}... `);
      const start = Date.now();
      const res = await runSingleBench(seed, strategy);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`Selesai (${elapsed}s) -> Total: ${rupiah(res.total)} (Delivered: ${res.delivered})`);
      results.push(res);
    }
    console.log("");
  }

  // Print Tabel Hasil Lengkap
  console.log("-----------------------------------------------------------------------------------------------------------------");
  console.log("| Seed | Strategi  | Delivered | Cancelled |        Revenue |      Penalties |          Total |");
  console.log("-----------------------------------------------------------------------------------------------------------------");
  for (const r of results) {
    const sStr = r.strategy.padEnd(9);
    const delStr = String(r.delivered).padStart(9);
    const canStr = String(r.cancelled).padStart(9);
    const revStr = rupiah(r.revenue).padStart(14);
    const penStr = rupiah(r.penalties).padStart(14);
    const totStr = rupiah(r.total).padStart(14);
    console.log(`| ${r.seed}    | ${sStr} | ${delStr} | ${canStr} | ${revStr} | ${penStr} | ${totStr} |`);
  }
  console.log("-----------------------------------------------------------------------------------------------------------------");

  // Hitung Rata-Rata Per Strategi
  const calcAvg = (strat: "greedy" | "insertion") => {
    const list = results.filter((r) => r.strategy === strat);
    const count = list.length;
    return {
      delivered: list.reduce((a, b) => a + b.delivered, 0) / count,
      cancelled: list.reduce((a, b) => a + b.cancelled, 0) / count,
      revenue: list.reduce((a, b) => a + b.revenue, 0) / count,
      penalties: list.reduce((a, b) => a + b.penalties, 0) / count,
      total: list.reduce((a, b) => a + b.total, 0) / count,
    };
  };

  const avgGreedy = calcAvg("greedy");
  const avgInsertion = calcAvg("insertion");

  console.log("\n==========================================================================");
  console.log("  RATA-RATA KINERJA PER STRATEGI");
  console.log("==========================================================================");
  console.log(`[GREEDY]    -> Delivered: ${avgGreedy.delivered.toFixed(1)}, Cancelled: ${avgGreedy.cancelled.toFixed(1)}, Revenue: ${rupiah(avgGreedy.revenue)}, Penalties: ${rupiah(avgGreedy.penalties)}, Total: ${rupiah(avgGreedy.total)}`);
  console.log(`[INSERTION] -> Delivered: ${avgInsertion.delivered.toFixed(1)}, Cancelled: ${avgInsertion.cancelled.toFixed(1)}, Revenue: ${rupiah(avgInsertion.revenue)}, Penalties: ${rupiah(avgInsertion.penalties)}, Total: ${rupiah(avgInsertion.total)}`);

  const deltaTotal = avgInsertion.total - avgGreedy.total;
  const pctGain = ((deltaTotal / Math.max(1, avgGreedy.total)) * 100).toFixed(1);
  console.log(`\n>> KESIMPULAN: Insertion menghasilkan laba ${pctGain}% lebih tinggi (${rupiah(deltaTotal)}) dibandingkan Greedy.`);
  console.log("==========================================================================\n");
}

main().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
