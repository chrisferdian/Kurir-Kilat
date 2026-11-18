// src/dispatcher/store.ts
// In-Memory Store & State Manager Dispatcher dengan dukungan snapshot file

import fs from "node:fs";
import path from "node:path";
import type {
  ApiStats,
  Courier,
  DashboardSnapshot,
  DecisionKind,
  DecisionLog,
  MapResponse,
  Order,
  OrderView,
  Risk,
  RunInfo,
  ScorePoint,
  ScoreResponse,
  SimEvent,
  StateResponse,
} from "../shared/types";
import type { DispatchConfig } from "./config";

export class Store {
  public runId: string | null = null;
  public map: MapResponse | null = null;
  public run: RunInfo | null = null;
  public couriers: Courier[] = [];
  public activeOrders: Map<string, Order> = new Map();
  public allKnownOrders: Map<string, Order> = new Map();
  public finishedOrders: Map<string, OrderView> = new Map(); // Maks 300 terakhir
  public decisions: DecisionLog[] = [];
  public scoreHistory: ScorePoint[] = [];
  public score: ScoreResponse | null = null;
  public eventCursor = 0;
  public knownCourierIds: Set<string> = new Set();
  public missingCouriers: Set<string> = new Set();
  public unknownEventTypesSeen: Set<string> = new Set();
  public apiStats: ApiStats;
  public simOnline = false;
  public strategy = "insertion";

  private blockedPairs: Map<string, number> = new Map(); // "orderId|courierId" -> untilTick
  private lastSkipLoggedTick: Map<string, number> = new Map(); // orderId -> tick
  private listeners: Set<() => void> = new Set();
  private decisionSeq = 0;
  private maxDecisions = 500;

  constructor(strategy = "insertion", apiStats?: ApiStats) {
    this.strategy = strategy;
    this.apiStats = apiStats || {
      requests: 0,
      errors: 0,
      rate_limited: 0,
      last_error: null,
    };
  }

  public reset(runId: string): void {
    this.runId = runId;
    this.run = null;
    this.couriers = [];
    this.activeOrders.clear();
    this.allKnownOrders.clear();
    this.finishedOrders.clear();
    this.decisions = [];
    this.scoreHistory = [];
    this.score = null;
    this.eventCursor = 0;
    this.knownCourierIds.clear();
    this.missingCouriers.clear();
    this.unknownEventTypesSeen.clear();
    this.blockedPairs.clear();
    this.lastSkipLoggedTick.clear();
    this.decisionSeq = 0;
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  public applyState(state: StateResponse): void {
    this.run = state.run;
    this.couriers = state.couriers;

    this.activeOrders.clear();
    for (const order of state.orders) {
      this.activeOrders.set(order.id, order);
      this.allKnownOrders.set(order.id, order);
    }

    const currentActiveIds = new Set(state.couriers.map((c) => c.id));

    // Kurir baru muncul / kembali aktif
    for (const c of state.couriers) {
      this.knownCourierIds.add(c.id);
      if (this.missingCouriers.has(c.id)) {
        this.missingCouriers.delete(c.id);
        this.log("event", `${c.id} kembali online`, undefined, c.id);
      }
    }

    // Deteksi kurir yang offline
    for (const id of this.knownCourierIds) {
      if (!currentActiveIds.has(id) && !this.missingCouriers.has(id)) {
        this.missingCouriers.add(id);
        // Hapus penangguhan blokir rute lama terkait kurir yang hilang
        for (const key of Array.from(this.blockedPairs.keys())) {
          if (key.endsWith(`|${id}`)) {
            this.blockedPairs.delete(key);
          }
        }
        this.log(
          "event",
          `${id} hilang dari state; order ASSIGNED-nya akan kembali OPEN`,
          undefined,
          id
        );
      }
    }
  }

  public applyEvents(events: SimEvent[]): { needMapRefresh: boolean } {
    let needMapRefresh = false;

    const knownTypes = new Set([
      "run.started",
      "order.created",
      "order.picked_up",
      "order.delivered",
      "order.cancelled",
      "zone.weather_changed",
      "courier.offline",
      "courier.online",
      "run.finished",
    ]);

    for (const ev of events) {
      if (ev.seq > this.eventCursor) {
        this.eventCursor = ev.seq;
      }

      if (ev.type === "order.created" && ev.data && ev.data.id) {
        this.allKnownOrders.set(ev.data.id, ev.data);
      } else if (ev.type === "order.picked_up" && ev.data && ev.data.order_id) {
        const order = this.allKnownOrders.get(ev.data.order_id);
        if (order) {
          order.status = "PICKED_UP";
          order.courier_id = ev.data.courier_id;
        }
      } else if (ev.type === "order.delivered") {
        const { order_id, courier_id, payout, late_ticks } = ev.data;
        const existing = this.activeOrders.get(order_id) || this.allKnownOrders.get(order_id);
        const orderView: OrderView = existing
          ? {
              ...existing,
              final_status: "DELIVERED",
              payout,
              eta_pickup: null,
              eta_dropoff: ev.tick,
              risk: late_ticks > 0 ? "late" : "ok",
              courier_id: courier_id || existing.courier_id,
            }
          : {
              id: order_id,
              restaurant: { id: "unknown", x: 0, y: 0 },
              dropoff: { x: 0, y: 0 },
              created_tick: ev.tick,
              estimated_ready_tick: ev.tick,
              deadline_tick: ev.tick,
              reward: payout,
              premium: false,
              status: "PICKED_UP",
              courier_id,
              final_status: "DELIVERED",
              payout,
              eta_pickup: null,
              eta_dropoff: ev.tick,
              risk: late_ticks > 0 ? "late" : "ok",
            };

        this.finishedOrders.set(order_id, orderView);
        this.activeOrders.delete(order_id);
        if (this.finishedOrders.size > 300) {
          const firstKey = this.finishedOrders.keys().next().value;
          if (firstKey) this.finishedOrders.delete(firstKey);
        }
      } else if (ev.type === "order.cancelled") {
        const { order_id, penalty } = ev.data;
        const existing = this.activeOrders.get(order_id) || this.allKnownOrders.get(order_id);
        const orderView: OrderView = existing
          ? {
              ...existing,
              final_status: "CANCELLED",
              payout: -penalty,
              eta_pickup: null,
              eta_dropoff: null,
              risk: "cancel",
            }
          : {
              id: order_id,
              restaurant: { id: "unknown", x: 0, y: 0 },
              dropoff: { x: 0, y: 0 },
              created_tick: ev.tick,
              estimated_ready_tick: ev.tick,
              deadline_tick: ev.tick,
              reward: penalty * 2,
              premium: false,
              status: "OPEN",
              courier_id: null,
              final_status: "CANCELLED",
              payout: -penalty,
              eta_pickup: null,
              eta_dropoff: null,
              risk: "cancel",
            };

        this.finishedOrders.set(order_id, orderView);
        this.activeOrders.delete(order_id);
        if (this.finishedOrders.size > 300) {
          const firstKey = this.finishedOrders.keys().next().value;
          if (firstKey) this.finishedOrders.delete(firstKey);
        }

        this.log(
          "event",
          `${order_id} dibatalkan pelanggan (denda Rp ${penalty.toLocaleString("id-ID")})`,
          order_id
        );
      } else if (ev.type === "zone.weather_changed") {
        needMapRefresh = true;
        this.log(
          "event",
          `Cuaca zona ${ev.data.zone} berganti jadi ${ev.data.weather}`
        );
      } else if (!knownTypes.has(ev.type)) {
        if (!this.unknownEventTypesSeen.has(ev.type)) {
          this.unknownEventTypesSeen.add(ev.type);
          this.log("event", `event tidak dikenal: ${ev.type} (diabaikan)`);
        }
      }
    }

    return { needMapRefresh };
  }

  public log(
    kind: DecisionKind,
    message: string,
    order_id?: string,
    courier_id?: string
  ): void {
    const tick = this.run ? this.run.tick : 0;

    // Dedupe log pesan skip untuk order yang sama jika belum > 20 tick
    if (kind === "skip" && order_id) {
      const lastTick = this.lastSkipLoggedTick.get(order_id);
      if (lastTick !== undefined && tick - lastTick <= 20) {
        return;
      }
      this.lastSkipLoggedTick.set(order_id, tick);
    }

    this.decisionSeq += 1;
    this.decisions.push({
      id: this.decisionSeq,
      tick,
      kind,
      order_id,
      courier_id,
      message,
    });

    if (this.decisions.length > this.maxDecisions) {
      this.decisions.shift();
    }
  }

  public block(orderId: string, courierId: string, untilTick: number): void {
    this.blockedPairs.set(`${orderId}|${courierId}`, untilTick);
  }

  public blockedSet(currentTick: number): Set<string> {
    const active = new Set<string>();
    for (const [key, untilTick] of this.blockedPairs.entries()) {
      if (currentTick <= untilTick) {
        active.add(key);
      } else {
        this.blockedPairs.delete(key);
      }
    }
    return active;
  }

  public addScore(score: ScoreResponse, tick: number): void {
    this.score = score;
    this.scoreHistory.push({
      ...score,
      tick,
    });
    // Batasi riwayat skor agar tidak membebani memori
    if (this.scoreHistory.length > 600) {
      this.scoreHistory.shift();
    }
  }

  public toSnapshot(
    etas: Map<string, { pickup: number | null; dropoff: number }>,
    cfg: DispatchConfig
  ): DashboardSnapshot {
    const tick = this.run ? this.run.tick : 0;
    const orderViews: OrderView[] = [];

    // 1. Order Aktif
    for (const order of this.activeOrders.values()) {
      const eta = etas.get(order.id);
      const etaPickup = eta ? eta.pickup : null;
      const etaDropoff = eta ? eta.dropoff : null;

      let risk: Risk = "ok";
      if (order.status !== "PICKED_UP") {
        const effectivePickup = etaPickup ?? tick;
        const patience = order.premium
          ? cfg.ASSUMED_PREMIUM_PATIENCE_TICKS
          : cfg.ASSUMED_PATIENCE_TICKS;

        if (effectivePickup > order.created_tick + patience) {
          risk = "cancel";
        } else if (etaDropoff !== null && etaDropoff > order.deadline_tick) {
          risk = "late";
        }
      } else {
        if (etaDropoff !== null && etaDropoff > order.deadline_tick) {
          risk = "late";
        }
      }

      orderViews.push({
        ...order,
        final_status: null,
        payout: null,
        eta_pickup: etaPickup,
        eta_dropoff: etaDropoff,
        risk,
      });
    }

    // 2. Order Selesai
    for (const finished of this.finishedOrders.values()) {
      orderViews.push(finished);
    }

    // Batasi keputusan ke 200 item terakhir untuk payload yang ringan
    const recentDecisions = this.decisions.slice(-200);

    return {
      run: this.run,
      map: this.map,
      couriers: this.couriers,
      orders: orderViews,
      score: this.score,
      score_history: this.scoreHistory,
      decisions: recentDecisions,
      missing_couriers: Array.from(this.missingCouriers),
      sim_online: this.simOnline,
      api: { ...this.apiStats },
      strategy: this.strategy,
    };
  }

  public save(dataDir: string): void {
    if (!this.runId) return;
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const filePath = path.join(dataDir, `snapshot-${this.runId}.json`);
      const payload = {
        runId: this.runId,
        eventCursor: this.eventCursor,
        decisions: this.decisions,
        scoreHistory: this.scoreHistory,
        finishedOrders: Array.from(this.finishedOrders.values()),
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf-8");
    } catch (err) {
      console.error("[Store] Gagal menyimpan snapshot:", err);
    }
  }

  public static load(
    dataDir: string,
    runId: string
  ): {
    eventCursor: number;
    decisions: DecisionLog[];
    scoreHistory: ScorePoint[];
    finishedOrders: OrderView[];
  } | null {
    try {
      const filePath = path.join(dataDir, `snapshot-${runId}.json`);
      if (!fs.existsSync(filePath)) return null;

      const raw = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(raw);
      return {
        eventCursor: data.eventCursor || 0,
        decisions: data.decisions || [],
        scoreHistory: data.scoreHistory || [],
        finishedOrders: data.finishedOrders || [],
      };
    } catch (err) {
      console.warn(`[Store] Gagal membaca snapshot ${runId}:`, err);
      return null;
    }
  }
}
