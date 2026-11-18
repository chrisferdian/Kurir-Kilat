// src/dispatcher/main.ts
// Program Utama Dispatcher & Server Dashboard Live (Express 4 + SSE)

import express, { type Request, type Response } from "express";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ScoreResponse } from "../shared/types";
import { ApiError, SimClient } from "./client";
import {
  DISPATCH_CONFIG,
  ENV,
  loadConfig,
  type DispatchConfig,
} from "./config";
import { estimateEtasForAll, plan } from "./planner";
import { Store } from "./store";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ==========================================
// 1. Core Dispatcher Loop
// ==========================================

export async function runDispatcher(opts: {
  env?: typeof ENV;
  cfg?: DispatchConfig;
  store?: Store;
}): Promise<ScoreResponse> {
  const env = opts.env || ENV;
  const cfg = opts.cfg || DISPATCH_CONFIG;
  const store = opts.store || new Store(env.STRATEGY);
  const client = new SimClient(env.SIM_URL, env.API_KEY, store.apiStats);

  // 1. Tunggu kota dapat dihubungi
  while (true) {
    try {
      store.map = await client.getMap();
      store.simOnline = true;
      break;
    } catch (err: any) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        throw new Error(`Autentikasi API Kota Gagal (HTTP ${err.status}): ${err.message}`);
      }
      store.simOnline = false;
      console.log("[Dispatcher] Menunggu kota dapat dihubungi...");
      await sleep(1000);
    }
  }

  // 2. Inisialisasi Practice Run atau ikuti run yang berjalan
  if (env.START_PRACTICE) {
    try {
      const practice = await client.startPractice(env.SEED);
      store.reset(practice.run_id);
      store.log(
        "info",
        `Memulai run latihan baru: ${practice.run_id} (seed: ${practice.seed})`
      );
    } catch (err: any) {
      console.error(
        "[Dispatcher] Gagal memulai practice run:",
        err.message || err
      );
      throw err;
    }
  } else {
    // Ikuti run yang sedang berjalan & coba load snapshot jika ada
    try {
      const state = await client.getState();
      store.runId = state.run.id;
      const loaded = Store.load("data", state.run.id);
      if (loaded) {
        store.hydrate(loaded);
        store.log(
          "info",
          `Melanjutkan run ${state.run.id} dari snapshot data/ (cursor event: ${store.eventCursor})`
        );
      }
    } catch (err: any) {
      console.warn("[Dispatcher] Gagal memuat state awal:", err.message || err);
    }
  }

  let lastProcessedTick = -1;

  // 3. Main Loop Dispatcher
  while (true) {
    try {
      const state = await client.getState();
      store.simOnline = true;

      // Deteksi pergantian run
      if (state.run.id !== store.runId) {
        store.reset(state.run.id);
        store.map = await client.getMap();
        lastProcessedTick = -1;
      }

      // Hindari memproses tick yang sama lebih dari sekali KECUALI jika run sudah selesai
      if (state.run.tick === lastProcessedTick) {
        // A finished run remains the current state until the city starts another one.
        // Avoid re-logging/re-saving its final score on every poll.
        if (state.run.status === "finished") {
          await sleep(1000);
          continue;
        }
        await sleep(Math.max(10, Math.min(100, Math.floor(state.run.tick_ms / 3))));
        continue;
      }

      lastProcessedTick = state.run.tick;

      // Merge state first so its current order details are available when events
      // complete orders. Then drain events; terminal events remove orders from
      // activeOrders even if this state response was captured just before delivery.
      store.applyState(state);

      // 1. Kuras semua event baru dari stream
      let hasMore = true;
      while (hasMore) {
        const eventsRes = await client.getEvents(store.eventCursor, 200);
        const { needMapRefresh } = store.applyEvents(eventsRes.data);
        if (needMapRefresh) {
          store.map = await client.getMap();
        }
        hasMore = eventsRes.has_more;
      }

      // Periksa apakah run sudah selesai
      if (state.run.status === "finished") {
        const finalScore = await client.getScore();
        store.addScore(finalScore, state.run.tick);
        store.save("data");
        store.log(
          "info",
          `Run selesai! Skor total: Rp ${finalScore.total.toLocaleString("id-ID")} (Delivered: ${finalScore.delivered}, Cancelled: ${finalScore.cancelled})`
        );
        store.notify();

        if (env.HEADLESS) {
          return finalScore;
        }

        // Jika mode interaktif (ada dashboard), tunggu run baru tanpa exit
        await sleep(2000);
        continue;
      }

      // Jalankan Algoritma Perencanaan Rute (Planner)
      const blockedSet = store.blockedSet(state.run.tick);
      const planResult = plan(
        {
          tick: state.run.tick,
          couriers: state.couriers,
          orders: state.orders,
          cfg,
          blocked: blockedSet,
        },
        env.STRATEGY
      );

      // Kirim pembaruan rute ke API Kota secara berurutan
      for (const [courierId, newStops] of planResult.routes.entries()) {
        const putRes = await client.putRoute(courierId, newStops);
        if (!putRes.ok) {
          const orderIds = Array.from(new Set(newStops.map((s) => s.order_id))).join(", ");
          store.log(
            "rejected",
            `Rute ${courierId} ditolak API: [${putRes.code}] ${putRes.message} (order: ${orderIds})`,
            undefined,
            courierId
          );

          if (putRes.code === "courier_not_found") {
            store.missingCouriers.add(courierId);
          }

          // Masukkan pasangan order-kurir ke blacklist sementara
          for (const s of newStops) {
            store.block(
              s.order_id,
              courierId,
              state.run.tick + cfg.BLOCK_PAIR_TICKS
            );
          }
        } else {
          // Log keputusan assign yang sukses
          for (const dec of planResult.decisions) {
            if (dec.courier_id === courierId && dec.kind === "assign") {
              store.log("assign", dec.message, dec.order_id, dec.courier_id);
            }
          }
        }
      }

      // Catat order yang terlewat (skip)
      for (const dec of planResult.decisions) {
        if (dec.kind === "skip") {
          store.log("skip", dec.message, dec.order_id);
        }
      }

      // Ambil skor berkala
      if (state.run.tick % cfg.SCORE_POLL_EVERY_TICKS === 0) {
        const score = await client.getScore();
        store.addScore(score, state.run.tick);
      }

      // Simpan cadangan snapshot berkala ke disk
      if (state.run.tick % cfg.SNAPSHOT_EVERY_TICKS === 0) {
        store.save("data");
      }

      // Siarkan pembaruan snapshot ke dashboard web via SSE
      store.notify();

      // Poll again immediately. The duplicate-tick guard above provides a short
      // wait when the city has not advanced, without adding a full tick of lag
      // after potentially slow state/event/route requests.
    } catch (err: any) {
      store.simOnline = false;
      store.log("error", `Terjadi kesalahan loop: ${err.message || err}`);
      console.error("[Dispatcher Loop Error]:", err.message || err);
      await sleep(1000);
    }
  }
}

// ==========================================
// 2. Server Dashboard Live (Express + SSE)
// ==========================================

export function startDashboard(
  store: Store,
  port: number,
  client: SimClient,
  env: typeof ENV
): Server {
  const app = express();
  const publicDir = path.resolve(process.cwd(), "public");

  app.use(express.json());
  app.use(express.static(publicDir));

  // Snapshot JSON endpoint
  app.get("/api/snapshot", (_req: Request, res: Response): void => {
    const etas = estimateEtasForAll(
      store.couriers,
      Array.from(store.activeOrders.values()),
      store.run?.tick || 0,
      DISPATCH_CONFIG
    );
    res.json(store.toSnapshot(etas, DISPATCH_CONFIG));
  });

  // Server-Sent Events (SSE) Stream
  app.get("/api/stream", (req: Request, res: Response): void => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.write("retry: 2000\n\n");

    const sendSnapshot = () => {
      const etas = estimateEtasForAll(
        store.couriers,
        Array.from(store.activeOrders.values()),
        store.run?.tick || 0,
        DISPATCH_CONFIG
      );
      const snapshot = store.toSnapshot(etas, DISPATCH_CONFIG);
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };

    // Kirim snapshot pertama segera setelah tersambung
    sendSnapshot();

    const unsubscribe = store.subscribe(sendSnapshot);

    // Heartbeat berkala tiap 15 detik agar koneksi tetap hidup
    const heartbeat = setInterval(() => {
      res.write(": heartbeat\n\n");
    }, 15000);

    req.on("close", () => {
      unsubscribe();
      clearInterval(heartbeat);
    });
  });

  // Trigger practice run baru dari UI
  app.post("/api/practice", async (req: Request, res: Response): Promise<void> => {
    if (!env.ALLOW_PRACTICE) {
      res.status(403).json({
        ok: false,
        error: "Memulai run baru dinonaktifkan untuk target ini. Set ALLOW_PRACTICE=true untuk mengizinkan.",
      });
      return;
    }
    try {
      const seed =
        typeof req.body?.seed === "number" ? req.body.seed : undefined;
      const practice = await client.startPractice(seed);
      res.json({ ok: true, run_id: practice.run_id, seed: practice.seed });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message || "Gagal memulai practice" });
    }
  });

  const server = app.listen(port, "127.0.0.1", () => {
    console.log(`[Dashboard Kurir Kilat] Tersedia di http://localhost:${port}`);
  });

  return server;
}

// ==========================================
// 3. CLI Direct Execution
// ==========================================

const isDirect =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    import.meta.url === pathToFileURL(process.argv[1]).href);

if (isDirect) {
  const env = ENV;
  const cfg = loadConfig();
  const store = new Store(env.STRATEGY);
  const client = new SimClient(env.SIM_URL, env.API_KEY, store.apiStats);

  if (!env.HEADLESS) {
    startDashboard(store, env.PORT, client, env);
  }

  runDispatcher({ env, cfg, store })
    .then((finalScore) => {
      if (env.HEADLESS) {
        console.log(JSON.stringify(finalScore, null, 2));
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error("[Dispatcher Fatal Error]:", err);
      process.exit(1);
    });
}
