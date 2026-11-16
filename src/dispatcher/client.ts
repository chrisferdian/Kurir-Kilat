// src/dispatcher/client.ts
// HTTP Client tangguh ke API Kota dengan dukungan retry 429 & exponential backoff

import type {
  ApiErrorBody,
  ApiStats,
  Courier,
  EventsResponse,
  MapResponse,
  PracticeResponse,
  ScoreResponse,
  StateResponse,
  Stop,
} from "../shared/types";

export class ApiError extends Error {
  public status: number;
  public code: string;

  constructor(status: number, code: string, message: string) {
    super(`[${code}] ${message} (HTTP ${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export class SimClient {
  private baseUrl: string;
  private apiKey: string;
  private stats: ApiStats;

  constructor(baseUrl: string, apiKey: string, stats: ApiStats) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.stats = stats;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async request(
    path: string,
    options: RequestInit = {},
    allow4xxReturn = false
  ): Promise<{ response: Response; body: any }> {
    const url = `${this.baseUrl}${path}`;
    const maxRetries = 3;
    const backoffMs = [200, 400, 800];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      this.stats.requests += 1;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      try {
        const res = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
            ...(options.headers || {}),
          },
        });

        clearTimeout(timeoutId);

        // 1. Tangani Rate Limit (HTTP 429)
        if (res.status === 429) {
          this.stats.rate_limited += 1;
          const retryAfterSec = parseInt(
            res.headers.get("Retry-After") || "1",
            10
          );
          const waitTime = (isNaN(retryAfterSec) ? 1 : retryAfterSec) * 1000;
          if (attempt < maxRetries) {
            await this.sleep(waitTime);
            continue;
          }
        }

        // 2. Tangani 4xx jika diizinkan (misalnya untuk PUT route validation)
        if (allow4xxReturn && res.status >= 400 && res.status < 500 && res.status !== 429) {
          const body = await res.json().catch(() => ({}));
          return { response: res, body };
        }

        // 3. Tangani Server Error (HTTP 5xx)
        if (res.status >= 500) {
          this.stats.errors += 1;
          this.stats.last_error = `HTTP ${res.status} pada ${path}`;
          if (attempt < maxRetries) {
            await this.sleep(backoffMs[attempt]);
            continue;
          }
        }

        const body = await res.json().catch(() => ({}));

        if (!res.ok) {
          this.stats.errors += 1;
          const errBody = body as ApiErrorBody;
          const code = errBody?.error?.code || "unknown_error";
          const msg = errBody?.error?.message || res.statusText;
          this.stats.last_error = `[${code}] ${msg}`;
          throw new ApiError(res.status, code, msg);
        }

        return { response: res, body };
      } catch (err: any) {
        clearTimeout(timeoutId);

        if (err instanceof ApiError) {
          throw err;
        }

        this.stats.errors += 1;
        const errorMsg =
          err.name === "AbortError"
            ? "Request timeout (5s)"
            : err.message || "Network Error";
        this.stats.last_error = errorMsg;

        if (attempt < maxRetries) {
          await this.sleep(backoffMs[attempt]);
          continue;
        }

        throw new ApiError(0, "network_error", errorMsg);
      }
    }

    throw new ApiError(0, "max_retries_exceeded", "Batas percobaan request terlampaui");
  }

  public async getMap(): Promise<MapResponse> {
    const { body } = await this.request("/v1/map");
    return body as MapResponse;
  }

  public async getState(): Promise<StateResponse> {
    const { body } = await this.request("/v1/state");
    return body as StateResponse;
  }

  public async getEvents(after = 0, limit = 50): Promise<EventsResponse> {
    const { body } = await this.request(`/v1/events?after=${after}&limit=${limit}`);
    return body as EventsResponse;
  }

  public async getScore(): Promise<ScoreResponse> {
    const { body } = await this.request("/v1/score");
    return body as ScoreResponse;
  }

  public async startPractice(seed?: number): Promise<PracticeResponse> {
    const { body } = await this.request("/v1/practice", {
      method: "POST",
      body: JSON.stringify(seed !== undefined ? { seed } : {}),
    });
    return body as PracticeResponse;
  }

  public async putRoute(
    courierId: string,
    stops: Stop[]
  ): Promise<
    | { ok: true; courier: Courier }
    | { ok: false; status: number; code: string; message: string }
  > {
    const { response, body } = await this.request(
      `/v1/couriers/${encodeURIComponent(courierId)}/route`,
      {
        method: "PUT",
        body: JSON.stringify({ stops }),
      },
      true // Izinkan return 4xx tanpa melempar exception
    );

    if (response.ok) {
      return { ok: true, courier: body as Courier };
    }

    const errBody = body as ApiErrorBody;
    const code = errBody?.error?.code || "route_rejected";
    const message = errBody?.error?.message || response.statusText;

    return {
      ok: false,
      status: response.status,
      code,
      message,
    };
  }
}
