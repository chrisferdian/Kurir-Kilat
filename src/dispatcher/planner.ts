// src/dispatcher/planner.ts
// Algoritma Dispatch Murni (Greedy & Insertion Heuristic)

import type { Courier, Order, Point, Stop } from "../shared/types";
import type { DispatchConfig } from "./config";

export interface PlannerInput {
  tick: number;
  couriers: Courier[];
  orders: Order[];
  cfg: DispatchConfig;
  blocked: Set<string>; // Pasangan "orderId|courierId" yang sedang di-blacklist sementara
}

export type DecisionKindPlanned = "assign" | "skip";

export interface PlannedDecision {
  kind: DecisionKindPlanned;
  order_id: string;
  courier_id?: string;
  message: string;
}

export interface Plan {
  routes: Map<string, Stop[]>; // Hanya kurir yang rutenya berubah
  decisions: PlannedDecision[];
}

export interface RouteSimulationResult {
  feasible: boolean;
  reason?: string;
  etas: Map<string, { pickup: number | null; dropoff: number }>;
  value: number;
  end_tick: number;
  max_load: number;
}

// ==========================================
// Helper Functions
// ==========================================

export function manhattan(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function simulateRoute(
  courier: Courier,
  stops: Stop[],
  ordersById: Map<string, Order>,
  tick: number,
  cfg: DispatchConfig
): RouteSimulationResult {
  const emptyEtas = new Map<string, { pickup: number | null; dropoff: number }>();

  // 1. Validasi batas jumlah stop
  if (stops.length > cfg.MAX_STOPS) {
    return {
      feasible: false,
      reason: `Jumlah stop (${stops.length}) melebihi MAX_STOPS (${cfg.MAX_STOPS})`,
      etas: emptyEtas,
      value: 0,
      end_tick: tick,
      max_load: courier.carrying.length,
    };
  }

  // 2. Validasi integritas order bawaan (carrying harus punya dropoff)
  const dropoffSeen = new Set<string>();
  const pickupSeen = new Set<string>();
  for (const s of stops) {
    if (s.action === "pickup") {
      if (pickupSeen.has(s.order_id)) {
        return {
          feasible: false,
          reason: `Pickup ganda untuk order ${s.order_id}`,
          etas: emptyEtas,
          value: 0,
          end_tick: tick,
          max_load: courier.carrying.length,
        };
      }
      pickupSeen.add(s.order_id);
    } else {
      if (dropoffSeen.has(s.order_id)) {
        return {
          feasible: false,
          reason: `Dropoff ganda untuk order ${s.order_id}`,
          etas: emptyEtas,
          value: 0,
          end_tick: tick,
          max_load: courier.carrying.length,
        };
      }
      dropoffSeen.add(s.order_id);
    }
  }

  for (const carriedId of courier.carrying) {
    if (!dropoffSeen.has(carriedId)) {
      return {
        feasible: false,
        reason: `Order ${carriedId} yang sedang dibawa tidak memiliki dropoff`,
        etas: emptyEtas,
        value: 0,
        end_tick: tick,
        max_load: courier.carrying.length,
      };
    }
  }

  // 3. Validasi urutan: pickup harus sebelum dropoff
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    if (s.action === "pickup") {
      const hasDropAfter = stops
        .slice(i + 1)
        .some((d) => d.order_id === s.order_id && d.action === "dropoff");
      if (!hasDropAfter) {
        return {
          feasible: false,
          reason: `Pickup ${s.order_id} tanpa dropoff sesudahnya`,
          etas: emptyEtas,
          value: 0,
          end_tick: tick,
          max_load: courier.carrying.length,
        };
      }
    } else if (s.action === "dropoff") {
      const isCarried = courier.carrying.includes(s.order_id);
      const hasPickupBefore = stops
        .slice(0, i)
        .some((p) => p.order_id === s.order_id && p.action === "pickup");
      if (!isCarried && !hasPickupBefore) {
        return {
          feasible: false,
          reason: `Dropoff ${s.order_id} tanpa pickup sebelumnya`,
          etas: emptyEtas,
          value: 0,
          end_tick: tick,
          max_load: courier.carrying.length,
        };
      }
    }
  }

  // 4. Simulasi kapasitas muatan
  let currentLoad = courier.carrying.length;
  let maxLoad = currentLoad;
  for (const s of stops) {
    if (s.action === "pickup") {
      currentLoad += 1;
      if (currentLoad > courier.capacity) {
        return {
          feasible: false,
          reason: `Kapasitas terlampaui (${currentLoad} > ${courier.capacity})`,
          etas: emptyEtas,
          value: 0,
          end_tick: tick,
          max_load: currentLoad,
        };
      }
      if (currentLoad > maxLoad) maxLoad = currentLoad;
    } else {
      currentLoad -= 1;
    }
  }

  // 5. Simulasi waktu tempuh & perkiraan ETA
  let currentPos: Point = { x: courier.x, y: courier.y };
  let currentTick = tick;
  const etas = new Map<string, { pickup: number | null; dropoff: number }>();

  // Inisialisasi ETA order yang sudah dibawa
  for (const id of courier.carrying) {
    etas.set(id, { pickup: null, dropoff: tick });
  }

  for (const stop of stops) {
    const order = ordersById.get(stop.order_id);
    if (!order) {
      return {
        feasible: false,
        reason: `Order ${stop.order_id} tidak ada di database pesanan`,
        etas: emptyEtas,
        value: 0,
        end_tick: tick,
        max_load: maxLoad,
      };
    }

    const targetPos = stop.action === "pickup" ? order.restaurant : order.dropoff;
    const travelTime = manhattan(currentPos, targetPos);
    currentTick += travelTime;
    currentPos = targetPos;

    if (stop.action === "pickup") {
      // Kurir menunggu jika tiba sebelum masakan siap
      currentTick = Math.max(currentTick, order.estimated_ready_tick);
      const existing = etas.get(order.id) || { pickup: null, dropoff: 0 };
      existing.pickup = currentTick;
      etas.set(order.id, existing);
    } else {
      const existing = etas.get(order.id) || { pickup: null, dropoff: 0 };
      existing.dropoff = currentTick;
      etas.set(order.id, existing);
    }
  }

  // 6. Hitung Value (Perkiraan Payout dikurangi Penalti Denda Batal)
  let totalValue = 0;
  for (const [orderId, eta] of etas.entries()) {
    const order = ordersById.get(orderId);
    if (!order) continue;

    let isCancelled = false;
    let cancelPenalty = 0;
    if (eta.pickup !== null) {
      const patience = order.premium
        ? cfg.ASSUMED_PREMIUM_PATIENCE_TICKS
        : cfg.ASSUMED_PATIENCE_TICKS;
      if (eta.pickup > order.created_tick + patience) {
        isCancelled = true;
        cancelPenalty = Math.round(
          order.reward * cfg.ASSUMED_CANCEL_PENALTY_RATE
        );
      }
    }

    if (isCancelled) {
      // Order batal sebelum pickup: tidak ada imbalan payout, dan perusahaan rugi denda pembatalan
      totalValue -= cancelPenalty;
    } else {
      const lateTicks = Math.max(0, eta.dropoff - order.deadline_tick);
      let payout = order.reward;
      if (lateTicks > 0) {
        payout = Math.round(
          order.reward *
            Math.max(0, 1 - cfg.ASSUMED_LATE_DECAY_PER_TICK * lateTicks)
        );
      }
      totalValue += payout;
    }
  }

  return {
    feasible: true,
    etas,
    value: totalValue,
    end_tick: currentTick,
    max_load: maxLoad,
  };
}

export function estimateEtasForAll(
  couriers: Courier[],
  orders: Order[],
  tick: number,
  cfg: DispatchConfig
): Map<string, { pickup: number | null; dropoff: number }> {
  const allEtas = new Map<string, { pickup: number | null; dropoff: number }>();
  const ordersById = new Map<string, Order>(orders.map((o) => [o.id, o]));

  for (const courier of couriers) {
    if (courier.route.length === 0) continue;
    const sim = simulateRoute(
      courier,
      courier.route,
      ordersById,
      tick,
      cfg
    );
    if (sim.feasible) {
      for (const [id, eta] of sim.etas.entries()) {
        allEtas.set(id, eta);
      }
    }
  }

  return allEtas;
}

// ==========================================
// Strategi Perencanaan (Planner Engine)
// ==========================================

export function plan(
  input: PlannerInput,
  strategy: "greedy" | "insertion"
): Plan {
  const { tick, couriers, orders, cfg, blocked } = input;
  const ordersById = new Map<string, Order>(orders.map((o) => [o.id, o]));

  // Buat copy working routes untuk setiap kurir
  const workingRoutes = new Map<string, Stop[]>();
  for (const c of couriers) {
    workingRoutes.set(
      c.id,
      c.route.map((s) => ({ ...s }))
    );
  }

  // Ambil order OPEN lalu urutkan: premium dulu, lalu deadline paling awal
  const openOrders = orders
    .filter((o) => o.status === "OPEN")
    .sort((a, b) => {
      if (a.premium !== b.premium) {
        return a.premium ? -1 : 1;
      }
      return a.deadline_tick - b.deadline_tick;
    });

  const decisions: PlannedDecision[] = [];

  if (strategy === "greedy") {
    // ==========================================
    // Strategi A: Greedy (Baseline)
    // ==========================================
    for (const order of openOrders) {
      let bestCourier: Courier | null = null;
      let minDistance = Infinity;

      for (const courier of couriers) {
        if (blocked.has(`${order.id}|${courier.id}`)) continue;

        const currentRoute = workingRoutes.get(courier.id) || [];
        if (currentRoute.length + 2 > cfg.MAX_STOPS) continue;

        // Hitung muatan aktif di working route
        const plannedPickups = currentRoute.filter(
          (s) => s.action === "pickup"
        ).length;
        if (courier.carrying.length + plannedPickups >= courier.capacity) {
          continue; // Penuh
        }

        // Tentukan posisi referensi terakhir kurir
        let refPos: Point = { x: courier.x, y: courier.y };
        if (currentRoute.length > 0) {
          const lastStop = currentRoute[currentRoute.length - 1];
          const lastOrder = ordersById.get(lastStop.order_id);
          if (lastOrder) {
            refPos =
              lastStop.action === "pickup"
                ? lastOrder.restaurant
                : lastOrder.dropoff;
          }
        }

        const dist = manhattan(refPos, order.restaurant);
        if (dist < minDistance) {
          minDistance = dist;
          bestCourier = courier;
        }
      }

      if (bestCourier) {
        const route = workingRoutes.get(bestCourier.id)!;
        route.push({ order_id: order.id, action: "pickup" });
        route.push({ order_id: order.id, action: "dropoff" });

        decisions.push({
          kind: "assign",
          order_id: order.id,
          courier_id: bestCourier.id,
          message: `${order.id} → ${bestCourier.id}: kurir terdekat (jarak ${minDistance})`,
        });
      } else {
        decisions.push({
          kind: "skip",
          order_id: order.id,
          message: `${order.id} belum di-assign: semua kurir penuh / tidak menguntungkan`,
        });
      }
    }
  } else {
    // ==========================================
    // Strategi B: Insertion Heuristic (Default)
    // ==========================================
    for (const order of openOrders) {
      let bestDelta = 0;
      let bestCourier: Courier | null = null;
      let bestNewRoute: Stop[] | null = null;
      let bestSim: RouteSimulationResult | null = null;
      let bestExtraTicks = 0;

      for (const courier of couriers) {
        if (blocked.has(`${order.id}|${courier.id}`)) continue;

        const currentRoute = workingRoutes.get(courier.id) || [];
        if (currentRoute.length + 2 > cfg.MAX_STOPS) continue;

        const baseSim = simulateRoute(
          courier,
          currentRoute,
          ordersById,
          tick,
          cfg
        );
        if (!baseSim.feasible) continue;

        // Coba semua kombinasi posisi sisip pickup (i) dan dropoff (j > i)
        const n = currentRoute.length;
        for (let i = 0; i <= n; i++) {
          for (let j = i + 1; j <= n + 1; j++) {
            const candidateRoute: Stop[] = [
              ...currentRoute.slice(0, i),
              { order_id: order.id, action: "pickup" },
              ...currentRoute.slice(i, j - 1),
              { order_id: order.id, action: "dropoff" },
              ...currentRoute.slice(j - 1),
            ];

            const candSim = simulateRoute(
              courier,
              candidateRoute,
              ordersById,
              tick,
              cfg
            );

            if (!candSim.feasible) continue;

            const extraTicks = Math.max(0, candSim.end_tick - baseSim.end_tick);
            const delta =
              candSim.value - baseSim.value - cfg.TIME_COST_PER_TICK * extraTicks;

            if (delta > bestDelta) {
              bestDelta = delta;
              bestCourier = courier;
              bestNewRoute = candidateRoute;
              bestSim = candSim;
              bestExtraTicks = extraTicks;
            }
          }
        }
      }

      if (bestCourier && bestNewRoute && bestSim) {
        workingRoutes.set(bestCourier.id, bestNewRoute);

        const eta = bestSim.etas.get(order.id);
        const dropoffEta = eta ? eta.dropoff : 0;
        const isLate = dropoffEta > order.deadline_tick;
        const lateTicks = Math.max(0, dropoffEta - order.deadline_tick);

        let msg = `${order.id} → ${bestCourier.id}: tambahan ${bestExtraTicks} tick, ETA antar t=${dropoffEta} (deadline ${order.deadline_tick}), muatan maks ${bestSim.max_load}/${bestCourier.capacity}`;
        if (isLate) {
          msg = `${order.id} → ${bestCourier.id}: tambahan ${bestExtraTicks} tick, ETA antar t=${dropoffEta} (deadline ${order.deadline_tick}, PERKIRAAN TELAT ${lateTicks} tick, tetap lebih untung daripada dibiarkan), muatan maks ${bestSim.max_load}/${bestCourier.capacity}`;
        }

        decisions.push({
          kind: "assign",
          order_id: order.id,
          courier_id: bestCourier.id,
          message: msg,
        });
      } else {
        decisions.push({
          kind: "skip",
          order_id: order.id,
          message: `${order.id} belum di-assign: semua kurir penuh / tidak menguntungkan`,
        });
      }
    }
  }

  // Filter HANYA rute kurir yang mengalami perubahan dari state semula
  const routesToUpdate = new Map<string, Stop[]>();
  for (const c of couriers) {
    const newRoute = workingRoutes.get(c.id) || [];
    const oldRoute = c.route;

    let isDifferent = newRoute.length !== oldRoute.length;
    if (!isDifferent) {
      for (let i = 0; i < newRoute.length; i++) {
        if (
          newRoute[i].order_id !== oldRoute[i].order_id ||
          newRoute[i].action !== oldRoute[i].action
        ) {
          isDifferent = true;
          break;
        }
      }
    }

    if (isDifferent) {
      routesToUpdate.set(c.id, newRoute);
    }
  }

  return {
    routes: routesToUpdate,
    decisions,
  };
}
