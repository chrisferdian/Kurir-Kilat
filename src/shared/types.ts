// src/shared/types.ts
// Kontrak bersama: Tipe API Kota & Tipe Dashboard

// ==========================================
// 1. Tipe API Kota (sesuai spec resmi)
// ==========================================

export interface Point {
  x: number;
  y: number;
}

export interface Restaurant {
  id: string;
  x: number;
  y: number;
}

export interface Zone {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  weather: "clear" | "rain" | string;
}

export interface MapResponse {
  width: number;
  height: number;
  restaurants: Restaurant[];
  zones: Zone[];
}

export interface RunInfo {
  id: string;
  mode: string;
  status: "running" | "finished" | string;
  tick: number;
  ticks: number;
  tick_ms: number;
}

export type CourierStatus = "idle" | "moving" | "waiting" | (string & {});

export interface Stop {
  order_id: string;
  action: "pickup" | "dropoff";
}

export interface Courier {
  id: string;
  x: number;
  y: number;
  capacity: number;
  status: CourierStatus;
  carrying: string[];
  route: Stop[];
}

export type OrderStatus = "OPEN" | "ASSIGNED" | "PICKED_UP";

export interface Order {
  id: string;
  restaurant: Restaurant;
  dropoff: Point;
  created_tick: number;
  estimated_ready_tick: number;
  deadline_tick: number;
  reward: number;
  premium: boolean;
  status: OrderStatus;
  courier_id: string | null;
}

export interface StateResponse {
  run: RunInfo;
  couriers: Courier[];
  orders: Order[];
}

export interface PracticeResponse {
  run_id: string;
  seed: number;
  ticks: number;
  tick_ms: number;
}

export interface SimEvent {
  seq: number;
  tick: number;
  type: string;
  data: any;
}

export interface EventsResponse {
  data: SimEvent[];
  next_cursor: number;
  has_more: boolean;
}

export interface ScoreResponse {
  delivered: number;
  cancelled: number;
  revenue: number;
  penalties: number;
  total: number;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// ==========================================
// 2. Tipe Dashboard & Internal Dispatcher
// ==========================================

export type Risk = "ok" | "late" | "cancel";

export interface OrderView extends Order {
  final_status: "DELIVERED" | "CANCELLED" | null;
  payout: number | null;
  eta_pickup: number | null;
  eta_dropoff: number | null;
  risk: Risk;
}

export type DecisionKind = "assign" | "rejected" | "skip" | "error" | "event" | "info";

export interface DecisionLog {
  id: number;
  tick: number;
  kind: DecisionKind;
  order_id?: string;
  courier_id?: string;
  message: string;
}

export interface ScorePoint extends ScoreResponse {
  tick: number;
}

export interface ApiStats {
  requests: number;
  errors: number;
  rate_limited: number;
  last_error: string | null;
}

export interface DashboardSnapshot {
  run: RunInfo | null;
  map: MapResponse | null;
  couriers: Courier[];
  orders: OrderView[];
  score: ScoreResponse | null;
  score_history: ScorePoint[];
  decisions: DecisionLog[];
  missing_couriers: string[];
  sim_online: boolean;
  api: ApiStats;
  strategy: string;
}
