// test/e2e.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runDispatcher } from "../src/dispatcher/main";
import { startSimServer } from "../src/sim/server";

describe("E2E Simulation & Dispatcher Run", () => {
  let sim: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    sim = await startSimServer({
      port: 0, // Port dinamis dari OS
      apiKey: "test-e2e-key",
      tickMs: 10,
      ticks: 300,
      seed: 42,
    });
  });

  afterAll(async () => {
    if (sim) {
      await sim.close();
    }
  });

  it("1. Headless runDispatcher menyelesaikan 300 tick dan menghasilkan keuntungan positif", async () => {
    const score = await runDispatcher({
      env: {
        SIM_URL: sim.url,
        API_KEY: "test-e2e-key",
        START_PRACTICE: true,
        ALLOW_PRACTICE: false,
        SEED: 42,
        HEADLESS: true,
        STRATEGY: "insertion",
        PORT: 0,
      },
    });

    expect(score.delivered).toBeGreaterThan(0);
    expect(score.total).toBeGreaterThan(0);
    expect(score.revenue).toBeGreaterThanOrEqual(score.total);
  }, 60000);

  it("2. API_KEY salah → runDispatcher gagal seketika dengan pesan jelas (bukan hang)", async () => {
    await expect(
      runDispatcher({
        env: {
          SIM_URL: sim.url,
          API_KEY: "kunci-salah-123",
          START_PRACTICE: true,
          ALLOW_PRACTICE: false,
          SEED: 42,
          HEADLESS: true,
          STRATEGY: "insertion",
          PORT: 0,
        },
      })
    ).rejects.toThrow(/Autentikasi API Kota Gagal/);
  }, 10000);
});
