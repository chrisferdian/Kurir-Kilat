// test/failures.test.ts
// Pengujian ketahanan sistem: Retry 429, Backoff 5xx, Kurir Offline, Event Tak Dikenal, dan Preservasi Order Selesai

import http from "node:http";
import { describe, expect, it } from "vitest";
import { SimClient } from "../src/dispatcher/client";
import { Store } from "../src/dispatcher/store";
import type { Order, StateResponse } from "../src/shared/types";

describe("Failure Handling & Resilience", () => {
  it("1. Client menangani 429 dengan Retry-After dan mencoba ulang hingga berhasil", async () => {
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts++;
      if (attempts < 2) {
        res.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "1",
        });
        res.end(
          JSON.stringify({
            error: { code: "rate_limited", message: "Too many requests" },
          })
        );
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            run: { id: "run_test", tick: 1, ticks: 10, tick_ms: 100, mode: "practice", status: "running" },
            couriers: [],
            orders: [],
          })
        );
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const stats = { requests: 0, errors: 0, rate_limited: 0, last_error: null };
    const client = new SimClient(`http://127.0.0.1:${port}`, "dev-key", stats);

    const state = await client.getState();
    expect(state.run.id).toBe("run_test");
    expect(stats.rate_limited).toBe(1);
    expect(attempts).toBe(2);

    server.close();
  });

  it("2. Client menangani 5xx dengan exponential backoff dan retry", async () => {
    let attempts = 0;
    const server = http.createServer((req, res) => {
      attempts++;
      if (attempts === 1) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { code: "server_error", message: "Internal crash" } }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            delivered: 1,
            cancelled: 0,
            revenue: 10000,
            penalties: 0,
            total: 10000,
          })
        );
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const stats = { requests: 0, errors: 0, rate_limited: 0, last_error: null };
    const client = new SimClient(`http://127.0.0.1:${port}`, "dev-key", stats);

    const score = await client.getScore();
    expect(score.total).toBe(10000);
    expect(stats.errors).toBe(1);
    expect(attempts).toBe(2);

    server.close();
  });

  it("3. PUT route 4xx tidak melempar exception fatal", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "capacity_exceeded", message: "Rute melebihi kapasitas kurir" },
        })
      );
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;

    const stats = { requests: 0, errors: 0, rate_limited: 0, last_error: null };
    const client = new SimClient(`http://127.0.0.1:${port}`, "dev-key", stats);

    const result = await client.putRoute("c1", []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("capacity_exceeded");
      expect(result.status).toBe(400);
    }

    server.close();
  });

  it("4. Event tidak dikenal dicatat satu kali dan tidak menyebabkan crash", () => {
    const store = new Store();
    store.reset("run_test");

    // Simulasi event courier.route_updated yang sengaja dikirim simulator untuk uji unknown event
    store.applyEvents([
      { seq: 1, tick: 5, type: "courier.route_updated", data: { courier_id: "c1", stops: 2 } },
      { seq: 2, tick: 6, type: "courier.route_updated", data: { courier_id: "c2", stops: 3 } },
      { seq: 3, tick: 7, type: "alien.ufo_spotted", data: {} },
    ]);

    expect(store.unknownEventTypesSeen.has("courier.route_updated")).toBe(true);
    expect(store.unknownEventTypesSeen.has("alien.ufo_spotted")).toBe(true);

    const unknownLogs = store.decisions.filter(
      (d) => d.kind === "event" && d.message.includes("event tidak dikenal")
    );

    // courier.route_updated muncul 2x di event, tetapi hanya dicatat 1x di log
    const routeUpdatedLogs = unknownLogs.filter((d) => d.message.includes("courier.route_updated"));
    expect(routeUpdatedLogs.length).toBe(1);

    const ufoLogs = unknownLogs.filter((d) => d.message.includes("alien.ufo_spotted"));
    expect(ufoLogs.length).toBe(1);
  });

  it("5. Kurir offline terdeteksi, penangguhan blokir rute dibersihkan, dan pulih saat online", () => {
    const store = new Store();
    store.reset("run_test");

    const state1: StateResponse = {
      run: { id: "run_test", tick: 1, ticks: 100, tick_ms: 100, mode: "practice", status: "running" },
      couriers: [
        { id: "c1", x: 0, y: 0, capacity: 3, status: "idle", carrying: [], route: [] },
        { id: "c2", x: 5, y: 5, capacity: 3, status: "idle", carrying: [], route: [] },
      ],
      orders: [],
    };
    store.applyState(state1);
    expect(store.knownCourierIds.has("c1")).toBe(true);
    expect(store.knownCourierIds.has("c2")).toBe(true);

    // Pasang blokir pasangan order-kurir untuk c1
    store.block("o1", "c1", 10);
    expect(store.blockedSet(1).has("o1|c1")).toBe(true);

    // Tick 2: c1 offline (hilang dari state)
    const state2: StateResponse = {
      run: { id: "run_test", tick: 2, ticks: 100, tick_ms: 100, mode: "practice", status: "running" },
      couriers: [
        { id: "c2", x: 5, y: 5, capacity: 3, status: "idle", carrying: [], route: [] },
      ],
      orders: [],
    };
    store.applyState(state2);

    expect(store.missingCouriers.has("c1")).toBe(true);
    // Blokir terkait c1 harus langsung dibersihkan agar order tidak tertahan
    expect(store.blockedSet(2).has("o1|c1")).toBe(false);

    const offlineLog = store.decisions.find((d) => d.message.includes("c1 hilang dari state"));
    expect(offlineLog).toBeDefined();

    // Tick 3: c1 kembali online
    const state3: StateResponse = {
      run: { id: "run_test", tick: 3, ticks: 100, tick_ms: 100, mode: "practice", status: "running" },
      couriers: [
        { id: "c1", x: 0, y: 0, capacity: 3, status: "idle", carrying: [], route: [] },
        { id: "c2", x: 5, y: 5, capacity: 3, status: "idle", carrying: [], route: [] },
      ],
      orders: [],
    };
    store.applyState(state3);

    expect(store.missingCouriers.has("c1")).toBe(false);
    const onlineLog = store.decisions.find((d) => d.message.includes("c1 kembali online"));
    expect(onlineLog).toBeDefined();
  });

  it("6. Order selesai dan batal mempertahankan data restoran & tujuan asli (bukan placeholder unknown)", () => {
    const store = new Store();
    store.reset("run_test");

    const originalOrder: Order = {
      id: "o100",
      restaurant: { id: "r_enak", x: 12, y: 14 },
      dropoff: { x: 22, y: 25 },
      created_tick: 10,
      estimated_ready_tick: 20,
      deadline_tick: 45,
      reward: 15000,
      premium: true,
      status: "PICKED_UP",
      courier_id: "c1",
    };

    // 1. Simpan order ke state / knownOrders
    store.applyState({
      run: { id: "run_test", tick: 15, ticks: 100, tick_ms: 100, mode: "practice", status: "running" },
      couriers: [{ id: "c1", x: 12, y: 14, capacity: 3, status: "moving", carrying: ["o100"], route: [] }],
      orders: [originalOrder],
    });

    // 2. Sekarang simulator menyelesaikan order (order hilang dari state, emit order.delivered)
    // Berdasarkan alur baru, events dikuras DAHULU:
    store.applyEvents([
      {
        seq: 1,
        tick: 28,
        type: "order.delivered",
        data: { order_id: "o100", courier_id: "c1", payout: 15000, late_ticks: 0 },
      },
    ]);

    // 3. State diperbarui di mana order o100 sudah tidak ada di state.orders
    store.applyState({
      run: { id: "run_test", tick: 28, ticks: 100, tick_ms: 100, mode: "practice", status: "running" },
      couriers: [{ id: "c1", x: 22, y: 25, capacity: 3, status: "idle", carrying: [], route: [] }],
      orders: [],
    });

    const finished = store.finishedOrders.get("o100");
    expect(finished).toBeDefined();
    // Data restoran & dropoff harus asli, BUKAN "unknown" atau (0,0)
    expect(finished?.restaurant.id).toBe("r_enak");
    expect(finished?.restaurant.x).toBe(12);
    expect(finished?.restaurant.y).toBe(14);
    expect(finished?.dropoff.x).toBe(22);
    expect(finished?.dropoff.y).toBe(25);
    expect(finished?.reward).toBe(15000);
    expect(finished?.payout).toBe(15000);
    expect(finished?.final_status).toBe("DELIVERED");
    expect(finished?.risk).toBe("ok");
  });
});
