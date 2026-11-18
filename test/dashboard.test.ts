// test/dashboard.test.ts
// Pengujian endpoint Dashboard (Snapshot, SSE Stream, Practice Trigger, dan State Hydration dari file)

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SimClient } from "../src/dispatcher/client";
import { startDashboard } from "../src/dispatcher/main";
import { Store } from "../src/dispatcher/store";
import type { DashboardSnapshot, MapResponse } from "../src/shared/types";

describe("Dashboard & Hydration", () => {
  let server: http.Server;
  let baseUrl: string;
  let store: Store;
  const testDataDir = path.resolve(process.cwd(), "test-data");

  beforeAll(async () => {
    store = new Store("insertion");
    store.reset("run_dash_test");
    store.run = {
      id: "run_dash_test",
      tick: 1,
      ticks: 100,
      tick_ms: 300,
      mode: "practice",
      status: "running",
    };
    store.map = {
      width: 30,
      height: 30,
      restaurants: [{ id: "r1", x: 2, y: 3 }],
      zones: [{ name: "barat-laut", x0: 0, y0: 0, x1: 14, y1: 14, weather: "clear" }],
    };
    store.couriers = [{ id: "c1", x: 5, y: 5, capacity: 3, status: "idle", carrying: [], route: [] }];
    store.simOnline = true;

    // Dummy client pointing to mock
    const dummyClient = new SimClient("http://127.0.0.1:9999", "dev-key", store.apiStats);
    dummyClient.startPractice = async (seed?: number) => ({
      run_id: "run_new_practice",
      seed: seed || 777,
      ticks: 600,
      tick_ms: 300,
    });

    server = startDashboard(store, 0, dummyClient, {
      SIM_URL: "",
      API_KEY: "",
      PORT: 0,
      SEED: undefined,
      START_PRACTICE: true,
      STRATEGY: "insertion",
      HEADLESS: false,
    });

    await new Promise<void>((resolve) => {
      server.on("listening", resolve);
    });

    const addr = server.address() as any;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fs.existsSync(testDataDir)) {
      fs.rmSync(testDataDir, { recursive: true, force: true });
    }
  });

  it("1. GET /api/snapshot mengembalikan snapshot JSON lengkap", async () => {
    const res = await fetch(`${baseUrl}/api/snapshot`);
    expect(res.status).toBe(200);
    const snap: DashboardSnapshot = await res.json();

    expect(snap.run?.id).toBe("run_dash_test");
    expect(snap.map?.width).toBe(30);
    expect(snap.couriers.length).toBe(1);
    expect(snap.sim_online).toBe(true);
    expect(snap.strategy).toBe("insertion");
  });

  it("2. GET /api/stream mengirim header SSE yang benar dan snapshot pertama", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${baseUrl}/api/stream`, {
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body?.getReader();
    expect(reader).toBeDefined();

    let chunks = "";
    if (reader) {
      const { value } = await reader.read();
      chunks = new TextDecoder().decode(value);
      reader.cancel();
    }
    clearTimeout(timeout);

    // Memastikan format SSE mengandung retry: 2000 dan event: snapshot
    expect(chunks).toContain("retry: 2000");
    expect(chunks).toContain("event: snapshot");
    expect(chunks).toContain("run_dash_test");
  });

  it("3. POST /api/practice memicu run latihan baru", async () => {
    const res = await fetch(`${baseUrl}/api/practice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seed: 999 }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.run_id).toBe("run_new_practice");
    expect(body.seed).toBe(999);
  });

  it("4. Store.save() dan Store.load() memulihkan state saat restart (START_PRACTICE=false)", () => {
    const hydStore = new Store("insertion");
    hydStore.reset("run_hydrate_test");
    hydStore.eventCursor = 42;
    hydStore.log("assign", "o1 -> c1", "o1", "c1");
    hydStore.addScore({ delivered: 5, cancelled: 1, revenue: 50000, penalties: 5000, total: 45000 }, 50);

    // Simpan snapshot ke direktori tes
    hydStore.save(testDataDir);

    const snapshotFile = path.join(testDataDir, "snapshot-run_hydrate_test.json");
    expect(fs.existsSync(snapshotFile)).toBe(true);

    // Muat kembali state dari snapshot seolah dispatcher baru restart
    const loaded = Store.load(testDataDir, "run_hydrate_test");
    expect(loaded).not.toBeNull();
    expect(loaded?.eventCursor).toBe(42);
    expect(loaded?.decisions.length).toBe(1);
    expect(loaded?.decisions[0].message).toBe("o1 -> c1");
    expect(loaded?.scoreHistory.length).toBe(1);
    expect(loaded?.scoreHistory[0].total).toBe(45000);
  });
});
