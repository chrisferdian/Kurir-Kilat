// test/planner.test.ts
import { describe, expect, it } from "vitest";
import { DISPATCH_CONFIG } from "../src/dispatcher/config";
import {
  estimateEtasForAll,
  plan,
  simulateRoute,
} from "../src/dispatcher/planner";
import type { Courier, Order } from "../src/shared/types";

function makeCourier(partial: Partial<Courier> = {}): Courier {
  return {
    id: partial.id || "c1",
    x: partial.x ?? 0,
    y: partial.y ?? 0,
    capacity: partial.capacity ?? 3,
    status: partial.status || "idle",
    carrying: partial.carrying ? [...partial.carrying] : [],
    route: partial.route ? partial.route.map((s) => ({ ...s })) : [],
  };
}

function makeOrder(partial: Partial<Order> = {}): Order {
  return {
    id: partial.id || "o1",
    restaurant: partial.restaurant || { id: "r1", x: 2, y: 2 },
    dropoff: partial.dropoff || { x: 5, y: 5 },
    created_tick: partial.created_tick ?? 0,
    estimated_ready_tick: partial.estimated_ready_tick ?? 0,
    deadline_tick: partial.deadline_tick ?? 50,
    reward: partial.reward ?? 10000,
    premium: partial.premium ?? false,
    status: partial.status || "OPEN",
    courier_id: partial.courier_id ?? null,
  };
}

describe("Planner Algorithms (Greedy & Insertion)", () => {
  it("1. simulateRoute: ETA benar, pickup menunggu estimated_ready_tick, infeasible saat capacity / 12 stop / dropoff sebelum pickup", () => {
    const courier = makeCourier({ x: 0, y: 0 });
    const order = makeOrder({
      id: "o1",
      restaurant: { id: "r1", x: 2, y: 0 }, // Jarak 2 tick
      dropoff: { x: 5, y: 0 }, // Jarak 3 tick dari resto
      estimated_ready_tick: 10, // Masakan baru siap tick 10
    });
    const ordersMap = new Map([[order.id, order]]);

    const stops = [
      { order_id: "o1", action: "pickup" as const },
      { order_id: "o1", action: "dropoff" as const },
    ];

    // Mulai dari tick 0:
    // Sampai di resto tick 2, tapi tunggu sampai tick 10 (estimated_ready_tick)
    // Lalu jalan ke dropoff (+3 tick) -> sampai tick 13
    const sim = simulateRoute(courier, stops, ordersMap, 0, DISPATCH_CONFIG);
    expect(sim.feasible).toBe(true);
    expect(sim.etas.get("o1")?.pickup).toBe(10);
    expect(sim.etas.get("o1")?.dropoff).toBe(13);
    expect(sim.end_tick).toBe(13);

    // Infeasible: dropoff sebelum pickup
    const badStops = [
      { order_id: "o1", action: "dropoff" as const },
      { order_id: "o1", action: "pickup" as const },
    ];
    const simBad = simulateRoute(
      courier,
      badStops,
      ordersMap,
      0,
      DISPATCH_CONFIG
    );
    expect(simBad.feasible).toBe(false);

    // Infeasible: capacity exceeded (kapasitas 1, bawa 2)
    const cSmall = makeCourier({ capacity: 1 });
    const o2 = makeOrder({ id: "o2" });
    const ordersMap2 = new Map([
      [order.id, order],
      [o2.id, o2],
    ]);
    const simCap = simulateRoute(
      cSmall,
      [
        { order_id: "o1", action: "pickup" },
        { order_id: "o2", action: "pickup" },
        { order_id: "o1", action: "dropoff" },
        { order_id: "o2", action: "dropoff" },
      ],
      ordersMap2,
      0,
      DISPATCH_CONFIG
    );
    expect(simCap.feasible).toBe(false);

    // Infeasible: > 12 stops
    const stops13 = Array.from({ length: 13 }, () => ({
      order_id: "o1",
      action: "pickup" as const,
    }));
    const simStops = simulateRoute(
      courier,
      stops13,
      ordersMap,
      0,
      DISPATCH_CONFIG
    );
    expect(simStops.feasible).toBe(false);
  });

  it("2. insertion memilih kurir yang paling sedikit menambah waktu", () => {
    // c1 di (0,0), c2 di (20,20)
    // order di restoran (1,1) dan dropoff (2,2)
    const c1 = makeCourier({ id: "c1", x: 0, y: 0 });
    const c2 = makeCourier({ id: "c2", x: 20, y: 20 });
    const order = makeOrder({
      id: "o1",
      restaurant: { id: "r1", x: 1, y: 1 },
      dropoff: { x: 2, y: 2 },
    });

    const planResult = plan(
      {
        tick: 0,
        couriers: [c1, c2],
        orders: [order],
        cfg: DISPATCH_CONFIG,
        blocked: new Set(),
      },
      "insertion"
    );

    expect(planResult.routes.has("c1")).toBe(true);
    expect(planResult.routes.has("c2")).toBe(false);
    expect(planResult.decisions[0].courier_id).toBe("c1");
  });

  it("3. insertion menyisipkan order searah di tengah rute (batching), bukan selalu di akhir", () => {
    // Kurir sudah punya rute: pickup o1 di (0,0), dropoff o1 di (10,0)
    // Order baru o2: resto di (3,0), dropoff di (7,0) (searah di tengah jalan!)
    const o1 = makeOrder({
      id: "o1",
      restaurant: { id: "r1", x: 0, y: 0 },
      dropoff: { x: 10, y: 0 },
      status: "ASSIGNED",
      courier_id: "c1",
    });
    const o2 = makeOrder({
      id: "o2",
      restaurant: { id: "r2", x: 3, y: 0 },
      dropoff: { x: 7, y: 0 },
      status: "OPEN",
    });

    const c1 = makeCourier({
      id: "c1",
      x: 0,
      y: 0,
      route: [
        { order_id: "o1", action: "pickup" },
        { order_id: "o1", action: "dropoff" },
      ],
    });

    const planResult = plan(
      {
        tick: 0,
        couriers: [c1],
        orders: [o1, o2],
        cfg: DISPATCH_CONFIG,
        blocked: new Set(),
      },
      "insertion"
    );

    const newRoute = planResult.routes.get("c1");
    expect(newRoute).toBeDefined();

    // Rute optimal: pickup o1 -> pickup o2 -> dropoff o2 -> dropoff o1
    expect(newRoute).toEqual([
      { order_id: "o1", action: "pickup" },
      { order_id: "o2", action: "pickup" },
      { order_id: "o2", action: "dropoff" },
      { order_id: "o1", action: "dropoff" },
    ]);
  });

  it("4. Rute yang dihasilkan tidak pernah melanggar capacity & MAX_STOPS (cek dengan 30 order acak)", () => {
    const couriers = [
      makeCourier({ id: "c1", x: 5, y: 5 }),
      makeCourier({ id: "c2", x: 15, y: 15 }),
      makeCourier({ id: "c3", x: 25, y: 25 }),
    ];

    const orders: Order[] = [];
    for (let i = 1; i <= 30; i++) {
      orders.push(
        makeOrder({
          id: `o${i}`,
          restaurant: {
            id: `r${(i % 5) + 1}`,
            x: (i * 3) % 30,
            y: (i * 7) % 30,
          },
          dropoff: { x: (i * 11) % 30, y: (i * 13) % 30 },
          reward: 10000 + i * 500,
          deadline_tick: 50 + i * 5,
        })
      );
    }

    const planResult = plan(
      {
        tick: 0,
        couriers,
        orders,
        cfg: DISPATCH_CONFIG,
        blocked: new Set(),
      },
      "insertion"
    );

    // Cek semua rute yang dihasilkan
    const ordersMap = new Map(orders.map((o) => [o.id, o]));
    for (const [cId, route] of planResult.routes.entries()) {
      const courier = couriers.find((c) => c.id === cId)!;
      const sim = simulateRoute(
        courier,
        route,
        ordersMap,
        0,
        DISPATCH_CONFIG
      );
      expect(sim.feasible).toBe(true);
      expect(route.length).toBeLessThanOrEqual(DISPATCH_CONFIG.MAX_STOPS);
      expect(sim.max_load).toBeLessThanOrEqual(courier.capacity);
    }
  });

  it("5. Pasangan di blocked tidak dipilih", () => {
    const c1 = makeCourier({ id: "c1", x: 0, y: 0 });
    const order = makeOrder({
      id: "o1",
      restaurant: { id: "r1", x: 1, y: 1 },
      dropoff: { x: 2, y: 2 },
    });

    const blocked = new Set<string>(["o1|c1"]);

    const planResult = plan(
      {
        tick: 0,
        couriers: [c1],
        orders: [order],
        cfg: DISPATCH_CONFIG,
        blocked,
      },
      "insertion"
    );

    expect(planResult.routes.has("c1")).toBe(false);
    expect(planResult.decisions[0].kind).toBe("skip");
  });

  it("6. Order ASSIGNED ke kurir lain tidak disentuh", () => {
    const c1 = makeCourier({ id: "c1", x: 0, y: 0 });
    const c2 = makeCourier({ id: "c2", x: 10, y: 10 });

    const orderAssigned = makeOrder({
      id: "o_assigned",
      status: "ASSIGNED",
      courier_id: "c1",
    });

    const planResult = plan(
      {
        tick: 0,
        couriers: [c1, c2],
        orders: [orderAssigned],
        cfg: DISPATCH_CONFIG,
        blocked: new Set(),
      },
      "insertion"
    );

    // Tidak ada order OPEN yang di-plan ulang ke c2
    expect(planResult.routes.size).toBe(0);
  });

  it("7. greedy memilih kurir terdekat", () => {
    // c1 di (2,2) jarak 2 ke resto (3,3)
    // c2 di (10,10) jarak 14 ke resto
    const c1 = makeCourier({ id: "c1", x: 2, y: 2 });
    const c2 = makeCourier({ id: "c2", x: 10, y: 10 });
    const order = makeOrder({
      id: "o1",
      restaurant: { id: "r1", x: 3, y: 3 },
      dropoff: { x: 5, y: 5 },
    });

    const planResult = plan(
      {
        tick: 0,
        couriers: [c1, c2],
        orders: [order],
        cfg: DISPATCH_CONFIG,
        blocked: new Set(),
      },
      "greedy"
    );

    expect(planResult.routes.has("c1")).toBe(true);
    expect(planResult.routes.has("c2")).toBe(false);
    expect(planResult.decisions[0].courier_id).toBe("c1");
    expect(planResult.decisions[0].message).toContain("kurir terdekat");
  });

  it("8. estimateEtasForAll menghasilkan ETA untuk kurir yang memiliki rute", () => {
    const c1 = makeCourier({
      id: "c1",
      x: 0,
      y: 0,
      route: [
        { order_id: "o1", action: "pickup" },
        { order_id: "o1", action: "dropoff" },
      ],
    });
    const order = makeOrder({
      id: "o1",
      restaurant: { id: "r1", x: 2, y: 0 },
      dropoff: { x: 4, y: 0 },
    });

    const etas = estimateEtasForAll([c1], [order], 0, DISPATCH_CONFIG);
    expect(etas.has("o1")).toBe(true);
    expect(etas.get("o1")?.pickup).toBe(2);
    expect(etas.get("o1")?.dropoff).toBe(4);
  });
});
