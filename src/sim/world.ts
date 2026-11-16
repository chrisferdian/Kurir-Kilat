// src/sim/world.ts
// Logika simulasi murni kota virtual (deterministik ber-seed)

import type {
  Courier,
  EventsResponse,
  MapResponse,
  Order,
  Point,
  Restaurant,
  ScoreResponse,
  SimEvent,
  StateResponse,
  Stop,
  Zone,
} from "../shared/types";
import { SIM_CONFIG, type SimConfig } from "./config";
import { createRng, type Rng } from "./rng";

export interface InternalOrder extends Order {
  actual_ready_tick: number;
}

export interface InternalCourier extends Courier {
  offlineUntil?: number;
}

// ==========================================
// Helper functions (dapat diekspor untuk tes)
// ==========================================

export function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function inZone(point: Point, zone: Zone): boolean {
  return (
    point.x >= zone.x0 &&
    point.x <= zone.x1 &&
    point.y >= zone.y0 &&
    point.y <= zone.y1
  );
}

export function stepToward(current: Point, target: Point): Point {
  // Aturan kota: gerak 1 sel per tick, horizontal dulu lalu vertikal
  if (current.x !== target.x) {
    return {
      x: current.x + (target.x > current.x ? 1 : -1),
      y: current.y,
    };
  }
  if (current.y !== target.y) {
    return {
      x: current.x,
      y: current.y + (target.y > current.y ? 1 : -1),
    };
  }
  return { ...current };
}

// ==========================================
// Class World
// ==========================================

export class World {
  private rng: Rng;
  private config: SimConfig;
  private runId: string;
  private seed: number;
  private totalTicks: number;
  private tickMs: number;
  private currentTick = 0;
  private status: "running" | "finished" = "running";

  private restaurants: Restaurant[] = [];
  private zones: Zone[] = [];
  private couriers: InternalCourier[] = [];
  private orders: Map<string, InternalOrder> = new Map();
  private events: SimEvent[] = [];
  private eventSeq = 0;
  private orderSeq = 0;

  // Skor
  private deliveredCount = 0;
  private cancelledCount = 0;
  private totalRevenue = 0;
  private totalPenalties = 0;

  constructor(opts: {
    seed: number;
    ticks: number;
    tickMs: number;
    config?: Partial<SimConfig>;
  }) {
    this.seed = opts.seed;
    this.totalTicks = opts.ticks;
    this.tickMs = opts.tickMs;
    this.config = { ...SIM_CONFIG, ...opts.config };
    this.rng = createRng(opts.seed);

    this.runId = `run_${this.seed}_${Math.floor(this.rng.next() * 100000)}`;

    this.initWorld();

    this.emitEvent("run.started", {
      run_id: this.runId,
      seed: this.seed,
      ticks: this.totalTicks,
      tick_ms: this.tickMs,
    });
  }

  private initWorld(): void {
    // 1. Inisialisasi restoran di sel unik
    const usedCells = new Set<string>();
    for (let i = 1; i <= this.config.RESTAURANT_COUNT; i++) {
      let x = 0;
      let y = 0;
      let key = "";
      do {
        x = this.rng.int(0, this.config.WIDTH - 1);
        y = this.rng.int(0, this.config.HEIGHT - 1);
        key = `${x},${y}`;
      } while (usedCells.has(key));
      usedCells.add(key);
      this.restaurants.push({ id: `r${i}`, x, y });
    }

    // 2. Inisialisasi 4 zona kuadran
    const midX = Math.floor(this.config.WIDTH / 2);
    const midY = Math.floor(this.config.HEIGHT / 2);

    this.zones = [
      {
        name: "barat-laut",
        x0: 0,
        y0: 0,
        x1: midX - 1,
        y1: midY - 1,
        weather: "clear",
      },
      {
        name: "timur-laut",
        x0: midX,
        y0: 0,
        x1: this.config.WIDTH - 1,
        y1: midY - 1,
        weather: "clear",
      },
      {
        name: "barat-daya",
        x0: 0,
        y0: midY,
        x1: midX - 1,
        y1: this.config.HEIGHT - 1,
        weather: "clear",
      },
      {
        name: "tenggara",
        x0: midX,
        y0: midY,
        x1: this.config.WIDTH - 1,
        y1: this.config.HEIGHT - 1,
        weather: "clear",
      },
    ];

    // 3. Inisialisasi kurir di sel acak
    for (let i = 1; i <= this.config.COURIER_COUNT; i++) {
      this.couriers.push({
        id: `c${i}`,
        x: this.rng.int(0, this.config.WIDTH - 1),
        y: this.rng.int(0, this.config.HEIGHT - 1),
        capacity: this.config.COURIER_CAPACITY,
        status: "idle",
        carrying: [],
        route: [],
      });
    }
  }

  private emitEvent(type: string, data: any): void {
    this.eventSeq += 1;
    this.events.push({
      seq: this.eventSeq,
      tick: this.currentTick,
      type,
      data,
    });
  }

  public get finished(): boolean {
    return this.status === "finished";
  }

  // ==========================================
  // Siklus Tick
  // ==========================================

  public tick(): void {
    if (this.finished) {
      return;
    }

    this.currentTick += 1;

    // 1. Pulihkan kurir offline jika durasinya sudah habis
    for (const courier of this.couriers) {
      if (
        courier.offlineUntil !== undefined &&
        this.currentTick >= courier.offlineUntil
      ) {
        courier.offlineUntil = undefined;
        courier.status = courier.route.length > 0 ? "moving" : "idle";
        this.emitEvent("courier.online", { courier_id: courier.id });
      }
    }

    // 2. Spawn order baru
    if (this.rng.chance(this.config.ORDER_RATE)) {
      this.spawnOrder();
    }

    // 3. Pergerakan dan pemrosesan rute kurir aktif
    for (const courier of this.couriers) {
      if (courier.offlineUntil !== undefined) {
        continue; // Sedang offline, tidak bergerak
      }

      this.processCourierMovementAndStops(courier);
    }

    // 4. Pembatalan order yang terlalu lama menunggu pickup
    this.checkOrderCancellations();

    // 5. Kemungkinan kurir hilang (offline sementara)
    for (const courier of this.couriers) {
      if (courier.offlineUntil !== undefined) continue;

      if (this.rng.chance(this.config.COURIER_OFFLINE_CHANCE)) {
        const duration = this.rng.int(
          this.config.OFFLINE_MIN,
          this.config.OFFLINE_MAX
        );
        courier.offlineUntil = this.currentTick + duration;

        // Lepas order yang baru direncanakan (belum dibawa) kembali ke OPEN
        const remainingStops: Stop[] = [];
        for (const stop of courier.route) {
          if (courier.carrying.includes(stop.order_id)) {
            // Dropoff untuk pesanan yang sudah di tas kurir tetap dipertahankan
            remainingStops.push(stop);
          } else {
            const order = this.orders.get(stop.order_id);
            if (order && order.status === "ASSIGNED") {
              order.status = "OPEN";
              order.courier_id = null;
            }
          }
        }
        courier.route = remainingStops;
        courier.status = "idle";
        this.emitEvent("courier.offline", { courier_id: courier.id });
      }
    }

    // 6. Perubahan cuaca zona
    if (this.currentTick % this.config.WEATHER_CHANGE_EVERY === 0) {
      for (const zone of this.zones) {
        if (this.rng.chance(this.config.WEATHER_CHANGE_CHANCE)) {
          zone.weather = zone.weather === "clear" ? "rain" : "clear";
          this.emitEvent("zone.weather_changed", {
            zone: zone.name,
            weather: zone.weather,
          });
        }
      }
    }

    // 7. Selesai jika mencapai batas ticks
    if (this.currentTick >= this.totalTicks) {
      this.status = "finished";
      this.emitEvent("run.finished", { score: this.getScore() });
    }
  }

  private spawnOrder(): void {
    this.orderSeq += 1;
    const orderId = `o${this.orderSeq}`;
    const restaurant = this.rng.pick(this.restaurants);

    let dropX = 0;
    let dropY = 0;
    do {
      dropX = this.rng.int(0, this.config.WIDTH - 1);
      dropY = this.rng.int(0, this.config.HEIGHT - 1);
    } while (dropX === restaurant.x && dropY === restaurant.y);

    const dropoff: Point = { x: dropX, y: dropY };

    const prep = this.rng.int(this.config.PREP_MIN, this.config.PREP_MAX);
    const estimatedReadyTick = this.currentTick + prep;
    const jitter = this.rng.int(
      this.config.READY_JITTER_MIN,
      this.config.READY_JITTER_MAX
    );
    const actualReadyTick = Math.max(
      this.currentTick,
      estimatedReadyTick + jitter
    );

    const dist = manhattan(restaurant, dropoff);
    let slack = this.rng.int(this.config.SLACK_MIN, this.config.SLACK_MAX);
    const isPremium = this.rng.chance(this.config.PREMIUM_CHANCE);

    if (isPremium) {
      slack = Math.max(1, slack - this.config.PREMIUM_SLACK_REDUCTION);
    }

    const deadlineTick = estimatedReadyTick + dist + slack;

    let rawReward =
      this.config.BASE_REWARD + this.config.REWARD_PER_CELL * dist;
    if (isPremium) {
      rawReward = Math.round(rawReward * this.config.PREMIUM_MULTIPLIER);
    }
    const reward = Math.round(rawReward / 500) * 500;

    const newOrder: InternalOrder = {
      id: orderId,
      restaurant: { ...restaurant },
      dropoff,
      created_tick: this.currentTick,
      estimated_ready_tick: estimatedReadyTick,
      actual_ready_tick: actualReadyTick,
      deadline_tick: deadlineTick,
      reward,
      premium: isPremium,
      status: "OPEN",
      courier_id: null,
    };

    this.orders.set(orderId, newOrder);
    this.emitEvent("order.created", this.toPublicOrder(newOrder));
  }

  private isCourierInRain(pos: Point): boolean {
    const zone = this.zones.find((z) => inZone(pos, z));
    return zone ? zone.weather === "rain" : false;
  }

  private getStopLocation(stop: Stop): Point | null {
    const order = this.orders.get(stop.order_id);
    if (!order) return null;
    return stop.action === "pickup" ? order.restaurant : order.dropoff;
  }

  private processCourierMovementAndStops(courier: InternalCourier): void {
    if (courier.route.length === 0) {
      courier.status = "idle";
      return;
    }

    const targetLoc = this.getStopLocation(courier.route[0]);
    if (!targetLoc) {
      // Order stop tidak ditemukan di daftar pesanan, buang stop
      courier.route.shift();
      return;
    }

    // Cek apakah kurir belum sampai ke lokasi stop pertama
    const notAtStop = courier.x !== targetLoc.x || courier.y !== targetLoc.y;
    if (notAtStop) {
      // Periksa apakah berada di zona hujan
      const inRain = this.isCourierInRain({ x: courier.x, y: courier.y });
      // Di zona hujan kurir hanya bergerak di tick genap
      if (inRain && this.currentTick % 2 !== 0) {
        courier.status = "moving";
        return;
      }

      const nextPos = stepToward({ x: courier.x, y: courier.y }, targetLoc);
      courier.x = nextPos.x;
      courier.y = nextPos.y;
      courier.status = "moving";
    }

    // Proses stop jika kurir berada tepat di lokasi stop
    while (courier.route.length > 0) {
      const currentStop = courier.route[0];
      const stopLoc = this.getStopLocation(currentStop);
      if (!stopLoc) {
        courier.route.shift();
        continue;
      }

      if (courier.x !== stopLoc.x || courier.y !== stopLoc.y) {
        break; // Belum sampai di stop ini
      }

      const order = this.orders.get(currentStop.order_id);
      if (!order) {
        courier.route.shift();
        continue;
      }

      if (currentStop.action === "pickup") {
        if (this.currentTick < order.actual_ready_tick) {
          // Makanan belum matang, kurir menunggu
          courier.status = "waiting";
          return;
        }

        // Makanan siap di-pickup
        order.status = "PICKED_UP";
        courier.carrying.push(order.id);
        courier.route.shift();
        this.emitEvent("order.picked_up", {
          order_id: order.id,
          courier_id: courier.id,
        });
      } else if (currentStop.action === "dropoff") {
        // Makanan diantarkan ke tujuan
        const late = Math.max(0, this.currentTick - order.deadline_tick);
        let payout = order.reward;
        if (late > 0) {
          payout = Math.round(
            order.reward *
              Math.max(0, 1 - this.config.LATE_DECAY_PER_TICK * late)
          );
        }

        this.totalRevenue += payout;
        this.deliveredCount += 1;

        courier.carrying = courier.carrying.filter((id) => id !== order.id);
        courier.route.shift();
        this.orders.delete(order.id);

        this.emitEvent("order.delivered", {
          order_id: order.id,
          courier_id: courier.id,
          payout,
          late_ticks: late,
        });
      }
    }

    if (courier.route.length === 0) {
      courier.status = "idle";
    } else {
      courier.status = "moving";
    }
  }

  private checkOrderCancellations(): void {
    const toCancel: string[] = [];

    for (const [id, order] of this.orders.entries()) {
      if (order.status === "OPEN" || order.status === "ASSIGNED") {
        const patience = order.premium
          ? this.config.PREMIUM_PATIENCE_TICKS
          : this.config.PATIENCE_TICKS;

        if (this.currentTick > order.created_tick + patience) {
          toCancel.push(id);
        }
      }
    }

    for (const id of toCancel) {
      const order = this.orders.get(id);
      if (!order) continue;

      const penalty = Math.round(order.reward * this.config.CANCEL_PENALTY_RATE);
      this.totalPenalties += penalty;
      this.cancelledCount += 1;

      // Hapus dari rute kurir jika sempat di-assign
      if (order.courier_id) {
        const courier = this.couriers.find((c) => c.id === order.courier_id);
        if (courier) {
          courier.route = courier.route.filter((s) => s.order_id !== order.id);
        }
      }

      this.orders.delete(id);
      this.emitEvent("order.cancelled", {
        order_id: id,
        reason: "customer_waited_too_long",
        penalty,
      });
    }
  }

  // ==========================================
  // API Methods
  // ==========================================

  public getMap(): MapResponse {
    return {
      width: this.config.WIDTH,
      height: this.config.HEIGHT,
      restaurants: this.restaurants.map((r) => ({ ...r })),
      zones: this.zones.map((z) => ({ ...z })),
    };
  }

  public getState(): StateResponse {
    const activeCouriers = this.couriers
      .filter((c) => c.offlineUntil === undefined)
      .map((c) => this.toPublicCourier(c));

    const activeOrders = Array.from(this.orders.values()).map((o) =>
      this.toPublicOrder(o)
    );

    return {
      run: {
        id: this.runId,
        mode: "practice",
        status: this.status,
        tick: this.currentTick,
        ticks: this.totalTicks,
        tick_ms: this.tickMs,
      },
      couriers: activeCouriers,
      orders: activeOrders,
    };
  }

  public getScore(): ScoreResponse {
    return {
      delivered: this.deliveredCount,
      cancelled: this.cancelledCount,
      revenue: this.totalRevenue,
      penalties: this.totalPenalties,
      total: this.totalRevenue - this.totalPenalties,
    };
  }

  public getEvents(after = 0, limit = 50): EventsResponse {
    const clampedLimit = Math.max(1, Math.min(200, limit));
    const filtered = this.events.filter((e) => e.seq > after);
    const data = filtered.slice(0, clampedLimit);
    const nextCursor =
      data.length > 0 ? data[data.length - 1].seq : after;
    const hasMore = filtered.length > data.length;

    return {
      data,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }

  public setRoute(
    courierId: string,
    stopsInput: unknown
  ):
    | { ok: true; courier: Courier }
    | { ok: false; status: number; code: string; message: string } {
    // 1. Kurir tidak ada / offline
    const courier = this.couriers.find((c) => c.id === courierId);
    if (!courier || courier.offlineUntil !== undefined) {
      return {
        ok: false,
        status: 404,
        code: "courier_not_found",
        message: `Kurir ${courierId} tidak ditemukan atau sedang offline`,
      };
    }

    // 2. Format stops valid
    if (!Array.isArray(stopsInput)) {
      return {
        ok: false,
        status: 400,
        code: "invalid_route",
        message: "Stops harus berupa array",
      };
    }

    for (const s of stopsInput) {
      if (
        !s ||
        typeof s !== "object" ||
        typeof s.order_id !== "string" ||
        (s.action !== "pickup" && s.action !== "dropoff")
      ) {
        return {
          ok: false,
          status: 400,
          code: "invalid_route",
          message: "Format elemen stop tidak valid",
        };
      }
    }

    const stops = stopsInput as Stop[];

    // 3. Maksimal MAX_STOPS
    if (stops.length > this.config.MAX_STOPS) {
      return {
        ok: false,
        status: 400,
        code: "too_many_stops",
        message: `Jumlah stops (${stops.length}) melebihi batas maksimal ${this.config.MAX_STOPS}`,
      };
    }

    // 4. Semua order_id ada di state
    for (const stop of stops) {
      if (!this.orders.has(stop.order_id)) {
        return {
          ok: false,
          status: 404,
          code: "order_not_found",
          message: `Order ${stop.order_id} tidak ditemukan`,
        };
      }
    }

    // 5. Pickup untuk order yang ASSIGNED ke kurir lain atau PICKED_UP
    for (const stop of stops) {
      if (stop.action === "pickup") {
        const order = this.orders.get(stop.order_id)!;
        if (order.status === "PICKED_UP") {
          return {
            ok: false,
            status: 409,
            code: "order_taken",
            message: `Order ${stop.order_id} sudah di-pickup kurir lain/sedang dibawa`,
          };
        }
        if (order.status === "ASSIGNED" && order.courier_id !== courier.id) {
          return {
            ok: false,
            status: 409,
            code: "order_taken",
            message: `Order ${stop.order_id} sudah ditugaskan ke kurir ${order.courier_id}`,
          };
        }
      }
    }

    // 6. Order sama muncul pickup dua kali / dropoff dua kali
    const pickupSeen = new Set<string>();
    const dropoffSeen = new Set<string>();
    for (const stop of stops) {
      if (stop.action === "pickup") {
        if (pickupSeen.has(stop.order_id)) {
          return {
            ok: false,
            status: 400,
            code: "invalid_route",
            message: `Order ${stop.order_id} muncul pickup lebih dari satu kali`,
          };
        }
        pickupSeen.add(stop.order_id);
      } else if (stop.action === "dropoff") {
        if (dropoffSeen.has(stop.order_id)) {
          return {
            ok: false,
            status: 400,
            code: "invalid_route",
            message: `Order ${stop.order_id} muncul dropoff lebih dari satu kali`,
          };
        }
        dropoffSeen.add(stop.order_id);
      }
    }

    // 7. Pickup harus diikuti dropoff; dropoff harus valid; carrying wajib punya dropoff
    for (const carriedId of courier.carrying) {
      if (!dropoffSeen.has(carriedId)) {
        return {
          ok: false,
          status: 400,
          code: "invalid_dropoff",
          message: `Order ${carriedId} yang sedang dibawa kurir wajib memiliki dropoff di rute`,
        };
      }
    }

    for (let i = 0; i < stops.length; i++) {
      const stop = stops[i];
      if (stop.action === "pickup") {
        // Harus ada dropoff setelah indeks i
        const hasDropoffAfter = stops
          .slice(i + 1)
          .some((s) => s.order_id === stop.order_id && s.action === "dropoff");
        if (!hasDropoffAfter) {
          return {
            ok: false,
            status: 400,
            code: "invalid_dropoff",
            message: `Pickup order ${stop.order_id} harus memiliki dropoff sesudahnya`,
          };
        }
      } else if (stop.action === "dropoff") {
        // Boleh dropoff jika sedang dibawa ATAU di-pickup sebelumnya
        const isCarried = courier.carrying.includes(stop.order_id);
        const hasPickupBefore = stops
          .slice(0, i)
          .some((s) => s.order_id === stop.order_id && s.action === "pickup");
        if (!isCarried && !hasPickupBefore) {
          return {
            ok: false,
            status: 400,
            code: "invalid_dropoff",
            message: `Dropoff order ${stop.order_id} tidak valid (tidak dibawa dan tidak di-pickup sebelumnya)`,
          };
        }
      }
    }

    // 8. Simulasi kapasitas muatan kurir
    let currentLoad = courier.carrying.length;
    for (const stop of stops) {
      if (stop.action === "pickup") {
        currentLoad += 1;
        if (currentLoad > courier.capacity) {
          return {
            ok: false,
            status: 400,
            code: "capacity_exceeded",
            message: `Rute melebihi kapasitas kurir (${courier.capacity})`,
          };
        }
      } else if (stop.action === "dropoff") {
        currentLoad -= 1;
      }
    }

    // SEMUA VALIDASI LOLOS
    // Kembalikan order yang sebelumnya ASSIGNED ke kurir ini tetapi tidak ada di rute baru ke OPEN
    const newRouteOrderIds = new Set(stops.map((s) => s.order_id));
    for (const oldStop of courier.route) {
      if (!newRouteOrderIds.has(oldStop.order_id)) {
        const order = this.orders.get(oldStop.order_id);
        if (order && order.status === "ASSIGNED") {
          order.status = "OPEN";
          order.courier_id = null;
        }
      }
    }

    // Pasang assignment baru
    for (const stop of stops) {
      if (stop.action === "pickup") {
        const order = this.orders.get(stop.order_id);
        if (order && order.status === "OPEN") {
          order.status = "ASSIGNED";
          order.courier_id = courier.id;
        }
      }
    }

    courier.route = stops;
    if (courier.status === "idle" && courier.route.length > 0) {
      courier.status = "moving";
    }

    this.emitEvent("courier.route_updated", {
      courier_id: courier.id,
      stops: stops.length,
    });

    return {
      ok: true,
      courier: this.toPublicCourier(courier),
    };
  }

  private toPublicOrder(o: InternalOrder): Order {
    return {
      id: o.id,
      restaurant: { ...o.restaurant },
      dropoff: { ...o.dropoff },
      created_tick: o.created_tick,
      estimated_ready_tick: o.estimated_ready_tick,
      deadline_tick: o.deadline_tick,
      reward: o.reward,
      premium: o.premium,
      status: o.status,
      courier_id: o.courier_id,
    };
  }

  private toPublicCourier(c: InternalCourier): Courier {
    return {
      id: c.id,
      x: c.x,
      y: c.y,
      capacity: c.capacity,
      status: c.status,
      carrying: [...c.carrying],
      route: c.route.map((s) => ({ ...s })),
    };
  }

  // ==========================================
  // Helper khusus testing (bukan API publik kota)
  // ==========================================
  public _addOrderForTest(partial: Partial<InternalOrder>): InternalOrder {
    const defaultRest = this.restaurants[0] || { id: "r1", x: 0, y: 0 };
    const id = partial.id || `o_test_${++this.orderSeq}`;
    const order: InternalOrder = {
      id,
      restaurant: partial.restaurant || { ...defaultRest },
      dropoff: partial.dropoff || { x: 5, y: 5 },
      created_tick: partial.created_tick ?? this.currentTick,
      estimated_ready_tick: partial.estimated_ready_tick ?? this.currentTick,
      actual_ready_tick: partial.actual_ready_tick ?? this.currentTick,
      deadline_tick: partial.deadline_tick ?? this.currentTick + 20,
      reward: partial.reward ?? 10000,
      premium: partial.premium ?? false,
      status: partial.status ?? "OPEN",
      courier_id: partial.courier_id ?? null,
    };
    this.orders.set(id, order);
    this.emitEvent("order.created", this.toPublicOrder(order));
    return order;
  }
}
