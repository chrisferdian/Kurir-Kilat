// src/sim/server.ts
// HTTP API Simulator Kota (Express 4) meniru persis spesifikasi kota asli

import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SIM_CONFIG, type SimConfig } from "./config";
import { World } from "./world";

export interface SimServerOptions {
  port: number;
  apiKey: string;
  tickMs: number;
  ticks: number;
  seed?: number;
  config?: Partial<SimConfig>;
}

export function startSimServer(opts: SimServerOptions): Promise<{
  url: string;
  close: () => Promise<void>;
  world: World;
}> {
  return new Promise((resolve, reject) => {
    const app = express();
    const simConfig: SimConfig = { ...SIM_CONFIG, ...opts.config };
    let currentSeed = opts.seed ?? Math.floor(Math.random() * 100000);
    let world = new World({
      seed: currentSeed,
      ticks: opts.ticks,
      tickMs: opts.tickMs,
      config: simConfig,
    });

    let tickTimer: NodeJS.Timeout | null = null;

    const startTicker = () => {
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = setInterval(() => {
        if (!world.finished) {
          world.tick();
        } else if (tickTimer) {
          clearInterval(tickTimer);
          tickTimer = null;
        }
      }, opts.tickMs);
    };

    startTicker();

    // 1. Parsing JSON dengan penanganan error syntax
    app.use(express.json());
    app.use(
      (
        err: any,
        _req: Request,
        res: Response,
        next: NextFunction
      ): void => {
        if (err instanceof SyntaxError && "body" in err) {
          res.status(400).json({
            error: {
              code: "invalid_json",
              message: "Format JSON tidak valid",
            },
          });
          return;
        }
        next(err);
      }
    );

    // 2. Token Bucket Rate Limiter
    // Jika tickMs dipercepat (misal tes / bench), laju rate limit disesuaikan secara proporsional
    const speedMultiplier = Math.max(1, Math.round(300 / opts.tickMs));
    const effectiveBurst = simConfig.RATE_LIMIT_BURST * speedMultiplier;
    const effectiveRatePerSec = simConfig.RATE_LIMIT_PER_SEC * speedMultiplier;

    let tokens: number = effectiveBurst;
    let lastRefill = Date.now();
    const refillRate = effectiveRatePerSec / 1000; // tokens per ms

    app.use((_req: Request, res: Response, next: NextFunction): void => {
      const now = Date.now();
      const elapsed = now - lastRefill;
      tokens = Math.min(effectiveBurst, tokens + elapsed * refillRate);
      lastRefill = now;

      if (tokens < 1) {
        res.setHeader("Retry-After", "1");
        res.status(429).json({
          error: {
            code: "rate_limited",
            message: "Terlalu banyak permintaan (rate limit terlampaui)",
          },
        });
        return;
      }

      tokens -= 1;
      next();
    });

    // 3. Middleware Autentikasi Bearer Token
    app.use((req: Request, res: Response, next: NextFunction): void => {
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${opts.apiKey}`;

      if (!authHeader || authHeader !== expected) {
        res.status(401).json({
          error: {
            code: "unauthorized",
            message: "API key tidak valid atau header Authorization salah",
          },
        });
        return;
      }
      next();
    });

    // 4. Endpoint Spesifikasi Kota
    app.get("/v1/map", (_req: Request, res: Response): void => {
      res.json(world.getMap());
    });

    app.post("/v1/practice", (req: Request, res: Response): void => {
      const newSeed =
        typeof req.body?.seed === "number"
          ? req.body.seed
          : Math.floor(Math.random() * 100000);

      currentSeed = newSeed;
      world = new World({
        seed: currentSeed,
        ticks: opts.ticks,
        tickMs: opts.tickMs,
        config: simConfig,
      });

      startTicker();
      console.log(`[Simulator] Run latihan baru dimulai (seed: ${currentSeed})`);

      const state = world.getState();
      res.json({
        run_id: state.run.id,
        seed: currentSeed,
        ticks: state.run.ticks,
        tick_ms: state.run.tick_ms,
      });
    });

    app.get("/v1/state", (_req: Request, res: Response): void => {
      res.json(world.getState());
    });

    app.put(
      "/v1/couriers/:id/route",
      (req: Request, res: Response): void => {
        const courierId = String(req.params.id);
        const result = world.setRoute(courierId, req.body?.stops);

        if (!result.ok) {
          console.warn(
            `[Simulator] Rute ditolak untuk kurir ${courierId}: [${result.code}] ${result.message}`
          );
          res.status(result.status).json({
            error: {
              code: result.code,
              message: result.message,
            },
          });
          return;
        }

        res.json(result.courier);
      }
    );

    app.get("/v1/events", (req: Request, res: Response): void => {
      const after = req.query.after ? parseInt(String(req.query.after), 10) : 0;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      res.json(world.getEvents(isNaN(after) ? 0 : after, isNaN(limit) ? 50 : limit));
    });

    app.get("/v1/score", (_req: Request, res: Response): void => {
      res.json(world.getScore());
    });

    // 5. 404 handler untuk route yang tidak dikenal
    app.use((_req: Request, res: Response): void => {
      res.status(404).json({
        error: {
          code: "not_found",
          message: "Endpoint tidak ditemukan",
        },
      });
    });

    const server: Server = app.listen(opts.port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort =
        typeof addr === "object" && addr ? addr.port : opts.port;
      const url = `http://127.0.0.1:${actualPort}`;
      resolve({
        url,
        world,
        close: () =>
          new Promise((resolveClose) => {
            if (tickTimer) clearInterval(tickTimer);
            server.close(() => resolveClose());
          }),
      });
    });

    server.on("error", (err) => reject(err));
  });
}

// Jalankan langsung jika file dieksekusi via CLI
const isDirectlyExecuted =
  process.argv[1] &&
  (fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) ||
    import.meta.url === pathToFileURL(process.argv[1]).href);

if (isDirectlyExecuted) {
  const SIM_PORT = parseInt(process.env.SIM_PORT || "4000", 10);
  const API_KEY = process.env.API_KEY || "dev-key";
  const TICK_MS = parseInt(process.env.TICK_MS || "300", 10);
  const TICKS = parseInt(process.env.TICKS || "600", 10);
  const SEED = process.env.SEED ? parseInt(process.env.SEED, 10) : undefined;

  startSimServer({
    port: SIM_PORT,
    apiKey: API_KEY,
    tickMs: TICK_MS,
    ticks: TICKS,
    seed: SEED,
  })
    .then(({ url }) => {
      console.log(`[Simulator Kota] Berjalan di ${url} (API Key: ${API_KEY}, Tick: ${TICK_MS}ms)`);
    })
    .catch((err) => {
      console.error("[Simulator Kota] Gagal memulai server:", err);
      process.exit(1);
    });
}
