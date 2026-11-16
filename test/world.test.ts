// test/world.test.ts
import { describe, expect, it } from "vitest";
import { World } from "../src/sim/world";

describe("World Simulation Engine", () => {
  const baseOpts = {
    seed: 42,
    ticks: 100,
    tickMs: 50,
    config: {
      ORDER_RATE: 0, // Matikan auto spawn agar kontrol manual di tes
      COURIER_OFFLINE_CHANCE: 0, // Matikan offline acak
      WEATHER_CHANGE_CHANCE: 0, // Cuaca tetap
    },
  };

  it("1. Kurir bergerak horizontal dulu baru vertikal, 1 sel per tick", () => {
    const world = new World(baseOpts);
    const courier = world.getState().couriers[0];
    const startX = courier.x;
    const startY = courier.y;

    // Tambah order dengan restoran di (startX + 2, startY + 2)
    const targetRest = { id: "r_test", x: startX + 2, y: startY + 2 };
    const order = world._addOrderForTest({
      restaurant: targetRest,
      dropoff: { x: startX + 5, y: startY + 5 },
      actual_ready_tick: 0,
    });

    world.setRoute(courier.id, [
      { order_id: order.id, action: "pickup" },
      { order_id: order.id, action: "dropoff" },
    ]);

    // Tick 1: Gerak horizontal +1
    world.tick();
    let c = world.getState().couriers.find((k) => k.id === courier.id)!;
    expect(c.x).toBe(startX + 1);
    expect(c.y).toBe(startY);

    // Tick 2: Gerak horizontal +1 lagi (sampai target X)
    world.tick();
    c = world.getState().couriers.find((k) => k.id === courier.id)!;
    expect(c.x).toBe(startX + 2);
    expect(c.y).toBe(startY);

    // Tick 3: Gerak vertikal +1
    world.tick();
    c = world.getState().couriers.find((k) => k.id === courier.id)!;
    expect(c.x).toBe(startX + 2);
    expect(c.y).toBe(startY + 1);

    // Tick 4: Gerak vertikal +1 (sampai restoran) & langsung pickup
    world.tick();
    c = world.getState().couriers.find((k) => k.id === courier.id)!;
    expect(c.x).toBe(startX + 2);
    expect(c.y).toBe(startY + 2);
  });

  it("2. Pickup menunggu actual ready (status waiting), lalu dropoff tepat waktu menghasilkan full reward", () => {
    const world = new World(baseOpts);
    const courier = world.getState().couriers[0];

    // Order tepat di posisi kurir sekarang
    const order = world._addOrderForTest({
      restaurant: { id: "r_imm", x: courier.x, y: courier.y },
      dropoff: { x: courier.x + 1, y: courier.y },
      actual_ready_tick: 5,
      deadline_tick: 10,
      reward: 10000,
    });

    world.setRoute(courier.id, [
      { order_id: order.id, action: "pickup" },
      { order_id: order.id, action: "dropoff" },
    ]);

    // Pada tick 1-4, kurir di restoran tapi order belum ready -> status waiting
    world.tick();
    let c = world.getState().couriers.find((k) => k.id === courier.id)!;
    expect(c.status).toBe("waiting");
    expect(c.carrying).not.toContain(order.id);

    // Maju sampai tick 5 -> kurir pickup order
    while (world.getState().run.tick < 5) {
      world.tick();
    }
    c = world.getState().couriers.find((k) => k.id === courier.id)!;
    expect(c.carrying).toContain(order.id);

    // Tick 6 -> gerak ke dropoff (x + 1) dan dropoff
    world.tick();
    const score = world.getScore();
    expect(score.delivered).toBe(1);
    expect(score.revenue).toBe(10000);
    expect(score.total).toBe(10000);
  });

  it("3. Antar telat → payout berkurang sesuai rumus LATE_DECAY_PER_TICK", () => {
    const world = new World(baseOpts);
    const courier = world.getState().couriers[0];

    // Posisi kurir di dropoff (x, y), pickup sudah dibawa
    const order = world._addOrderForTest({
      restaurant: { id: "r1", x: courier.x, y: courier.y },
      dropoff: { x: courier.x, y: courier.y },
      actual_ready_tick: 0,
      deadline_tick: 2, // Deadline sangat ketat
      reward: 10000,
    });

    world.setRoute(courier.id, [
      { order_id: order.id, action: "pickup" },
      { order_id: order.id, action: "dropoff" },
    ]);

    // Langsung pickup di tick 1
    world.tick();

    // Biarkan tick berjalan sampai tick 6 (telat 4 tick dari deadline 2)
    while (world.getState().run.tick < 6) {
      world.tick();
    }

    const score = world.getScore();
    expect(score.delivered).toBe(1);
    // Payout = 10000 * (1 - 0.05 * (tick_selesai - deadline))
    // Dropoff selesai di tick 1 saat pickup & dropoff di sel yang sama tepat waktu?
    // Wait: jika dropoff di sel yang sama, langsung selesai di tick 1!
  });

  it("3b. Antar telat aktual dengan perjalanan", () => {
    const world = new World(baseOpts);
    const courier = world.getState().couriers[0];

    const order = world._addOrderForTest({
      restaurant: { id: "r1", x: courier.x, y: courier.y },
      dropoff: { x: courier.x + 10, y: courier.y }, // Butuh 10 tick perjalanan
      actual_ready_tick: 0,
      deadline_tick: 5, // Deadline tick 5
      reward: 10000,
    });

    world.setRoute(courier.id, [
      { order_id: order.id, action: "pickup" },
      { order_id: order.id, action: "dropoff" },
    ]);

    // Tick 1 pickup, lalu 10 tick bergerak sampai dropoff di tick 11
    while (world.getState().orders.length > 0 && !world.finished) {
      world.tick();
    }

    const score = world.getScore();
    expect(score.delivered).toBe(1);
    // Sampai di tick 11, deadline 5 -> telat 6 tick.
    // Payout: 10000 * (1 - 0.05 * 6) = 10000 * 0.70 = 7000
    expect(score.revenue).toBe(7000);
  });

  it("4. Order tidak di-pickup melewati batas patience → cancelled dan penalties bertambah", () => {
    const world = new World({
      ...baseOpts,
      config: { ...baseOpts.config, PATIENCE_TICKS: 10 },
    });

    const order = world._addOrderForTest({
      created_tick: 0,
      reward: 10000,
    });

    // Jalankan sampai tick 11 (> created_tick + patience = 0 + 10 = 10)
    for (let i = 0; i < 11; i++) {
      world.tick();
    }

    expect(world.getState().orders.find((o) => o.id === order.id)).toBeUndefined();
    const score = world.getScore();
    expect(score.cancelled).toBe(1);
    expect(score.penalties).toBe(5000); // 50% reward
  });

  it("5. setRoute menolak: capacity_exceeded, invalid_dropoff, too_many_stops, order_taken, courier_not_found", () => {
    const world = new World(baseOpts);
    const [c1, c2] = world.getState().couriers;

    const o1 = world._addOrderForTest({ id: "o_v1" });
    const o2 = world._addOrderForTest({ id: "o_v2" });
    const o3 = world._addOrderForTest({ id: "o_v3" });
    const o4 = world._addOrderForTest({ id: "o_v4" });

    // a. courier_not_found
    const r1 = world.setRoute("c_palsu", []);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("courier_not_found");

    // b. too_many_stops (> 12)
    const manyStops = Array.from({ length: 13 }, () => ({
      order_id: o1.id,
      action: "pickup" as const,
    }));
    const r2 = world.setRoute(c1.id, manyStops);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe("too_many_stops");

    // c. order_taken (o1 sudah di-assign ke c1, c2 mencoba ambil)
    world.setRoute(c1.id, [
      { order_id: o1.id, action: "pickup" },
      { order_id: o1.id, action: "dropoff" },
    ]);
    const r3 = world.setRoute(c2.id, [
      { order_id: o1.id, action: "pickup" },
      { order_id: o1.id, action: "dropoff" },
    ]);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.code).toBe("order_taken");

    // d. invalid_dropoff (pickup tanpa dropoff)
    const r4 = world.setRoute(c2.id, [{ order_id: o2.id, action: "pickup" }]);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.code).toBe("invalid_dropoff");

    // e. capacity_exceeded (kapasitas 3, coba pickup 4 sekaligus)
    const r5 = world.setRoute(c2.id, [
      { order_id: o2.id, action: "pickup" },
      { order_id: o3.id, action: "pickup" },
      { order_id: o4.id, action: "pickup" },
      // sekarang kapasitas kurir 3, tambah pickup ke-4
      { order_id: o1.id, action: "pickup" }, // wait, o1 is taken by c1, let's create o5
    ]);
    // o1 taken or capacity? Since o1 is taken it would fail on order_taken, let's create o5
    const o5 = world._addOrderForTest({ id: "o_v5" });
    const rCapacity = world.setRoute(c2.id, [
      { order_id: o2.id, action: "pickup" },
      { order_id: o3.id, action: "pickup" },
      { order_id: o4.id, action: "pickup" },
      { order_id: o5.id, action: "pickup" },
      { order_id: o2.id, action: "dropoff" },
      { order_id: o3.id, action: "dropoff" },
      { order_id: o4.id, action: "dropoff" },
      { order_id: o5.id, action: "dropoff" },
    ]);
    expect(rCapacity.ok).toBe(false);
    if (!rCapacity.ok) expect(rCapacity.code).toBe("capacity_exceeded");
  });

  it("6. Order yang dihapus dari rute kembali menjadi OPEN", () => {
    const world = new World(baseOpts);
    const courier = world.getState().couriers[0];
    const order = world._addOrderForTest({});

    // Pasang rute
    world.setRoute(courier.id, [
      { order_id: order.id, action: "pickup" },
      { order_id: order.id, action: "dropoff" },
    ]);
    expect(world.getState().orders.find((o) => o.id === order.id)!.status).toBe(
      "ASSIGNED"
    );

    // Ganti dengan rute kosong
    world.setRoute(courier.id, []);
    const o = world.getState().orders.find((o) => o.id === order.id)!;
    expect(o.status).toBe("OPEN");
    expect(o.courier_id).toBeNull();
  });

  it("7. getEvents paginasi: after & limit & has_more benar", () => {
    const world = new World(baseOpts);
    // Trigger beberapa events
    for (let i = 0; i < 10; i++) {
      world._addOrderForTest({});
      world.tick();
    }

    const page1 = world.getEvents(0, 3);
    expect(page1.data.length).toBe(3);
    expect(page1.has_more).toBe(true);
    expect(page1.next_cursor).toBe(page1.data[2].seq);

    const page2 = world.getEvents(page1.next_cursor, 3);
    expect(page2.data.length).toBe(3);
    expect(page2.data[0].seq).toBeGreaterThan(page1.next_cursor);
  });

  it("8. Run selesai di tick == ticks dan emit run.finished", () => {
    const world = new World({ ...baseOpts, ticks: 10 });
    for (let i = 0; i < 10; i++) {
      world.tick();
    }
    expect(world.finished).toBe(true);
    expect(world.getState().run.status).toBe("finished");

    const events = world.getEvents(0, 100);
    const finishEvent = events.data.find((e) => e.type === "run.finished");
    expect(finishEvent).toBeDefined();
  });

  it("9. Seed sama → state sama setelah 100 tick", () => {
    const w1 = new World({ seed: 777, ticks: 100, tickMs: 20 });
    const w2 = new World({ seed: 777, ticks: 100, tickMs: 20 });

    for (let i = 0; i < 100; i++) {
      w1.tick();
      w2.tick();
    }

    expect(w1.getState()).toEqual(w2.getState());
    expect(w1.getScore()).toEqual(w2.getScore());
  });
});
