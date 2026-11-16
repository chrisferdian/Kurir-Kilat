// public/app.js
// Dashboard Client Live (Vanilla JS + SVG + SSE + Chart.js)

(() => {
  const CELL_SIZE = 20;
  const COURIER_COLORS = [
    "#38bdf8", // cyan
    "#f43f5e", // rose
    "#a855f7", // purple
    "#22c55e", // green
    "#eab308", // yellow
    "#ec4899", // pink
    "#14b8a6", // teal
    "#f97316", // orange
  ];

  const rupiahFormatter = new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  });

  // DOM Elements
  const elRunId = document.getElementById("run-id");
  const elRunTick = document.getElementById("run-tick");
  const elStrategy = document.getElementById("strategy");
  const elRunProgress = document.getElementById("run-progress");
  const elConn = document.getElementById("conn");
  const elSimStatus = document.getElementById("sim-status");
  const elRateLimitBadge = document.getElementById("rate-limit-badge");
  const elOfflineCourierBadge = document.getElementById("offline-courier-badge");
  const elMapTitle = document.getElementById("map-title");
  const elSeed = document.getElementById("seed");
  const elBtnPractice = document.getElementById("btn-practice");

  const elSTotal = document.getElementById("s-total");
  const elSRevenue = document.getElementById("s-revenue");
  const elSPenalties = document.getElementById("s-penalties");
  const elSDelivered = document.getElementById("s-delivered");
  const elSCancelled = document.getElementById("s-cancelled");

  const svgMap = document.getElementById("map");
  const gStatic = document.getElementById("layer-static");
  const gRoutes = document.getElementById("layer-routes");
  const gDynamic = document.getElementById("layer-dynamic");

  const elLogList = document.getElementById("log");
  const elOrdersTbody = document.getElementById("orders-tbody");
  const chkShowFinished = document.getElementById("chk-show-finished");

  // State Caching
  let lastTick = -1;
  let lastDecisionsLength = 0;
  let lastMapHash = "";
  let latestSnapshot = null;
  let renderPending = false;
  let lastLoggedId = 0;

  // DOM Element Pools
  const dynamicSvgElements = new Map(); // id -> SVGElement
  const orderRowElements = new Map(); // id -> HTMLTableRowElement

  // 1. Inisialisasi Chart.js
  const ctxChart = document.getElementById("score-chart").getContext("2d");
  const scoreChart = new Chart(ctxChart, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          label: "Total Keuntungan",
          borderColor: "#38bdf8",
          backgroundColor: "rgba(56, 189, 248, 0.1)",
          data: [],
          borderWidth: 2,
          pointRadius: 0,
          fill: true,
          tension: 0.1,
        },
        {
          label: "Pendapatan",
          borderColor: "#4ade80",
          data: [],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
        },
        {
          label: "Denda Penalti",
          borderColor: "#f87171",
          data: [],
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      scales: {
        x: {
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: { color: "#64748b", font: { size: 10 } },
        },
        y: {
          grid: { color: "rgba(255, 255, 255, 0.05)" },
          ticks: {
            color: "#64748b",
            font: { size: 10 },
            callback: (val) => "Rp " + (Number(val) / 1000).toFixed(0) + "k",
          },
        },
      },
      plugins: {
        legend: {
          display: true,
          position: "top",
          labels: { color: "#94a3b8", font: { size: 10 }, boxWidth: 10 },
        },
      },
    },
  });

  // 2. Render Loop dengan requestAnimationFrame
  function scheduleRender() {
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        if (latestSnapshot) {
          renderDashboard(latestSnapshot);
        }
      });
    }
  }

  function renderDashboard(snap) {
    const tick = snap.run ? snap.run.tick : 0;
    const ticks = snap.run ? snap.run.ticks : 600;

    // A. Render Header
    elRunId.textContent = snap.run ? snap.run.id : "Tidak ada run";
    elRunTick.textContent = `Tick: ${tick}/${ticks}`;
    elStrategy.textContent = `Strategi: ${snap.strategy.toUpperCase()}`;
    const pct = ticks > 0 ? (tick / ticks) * 100 : 0;
    elRunProgress.style.width = `${Math.min(100, pct)}%`;

    elSimStatus.textContent = snap.sim_online ? "Sim: Online" : "Sim: Offline";
    elSimStatus.style.color = snap.sim_online ? "#4ade80" : "#f87171";

    if (snap.api && snap.api.rate_limited > 0) {
      elRateLimitBadge.style.display = "inline-block";
      elRateLimitBadge.textContent = `429: ${snap.api.rate_limited}`;
    } else {
      elRateLimitBadge.style.display = "none";
    }

    if (elOfflineCourierBadge) {
      if (snap.missing_couriers && snap.missing_couriers.length > 0) {
        elOfflineCourierBadge.style.display = "inline-block";
        elOfflineCourierBadge.textContent = `Offline: ${snap.missing_couriers.join(", ")}`;
      } else {
        elOfflineCourierBadge.style.display = "none";
      }
    }

    // B. Render Skor & Chart
    if (snap.score) {
      elSTotal.textContent = rupiahFormatter.format(snap.score.total);
      elSRevenue.textContent = rupiahFormatter.format(snap.score.revenue);
      elSPenalties.textContent = rupiahFormatter.format(snap.score.penalties);
      elSDelivered.textContent = snap.score.delivered.toLocaleString("id-ID");
      elSCancelled.textContent = snap.score.cancelled.toLocaleString("id-ID");
    }

    if (snap.score_history && snap.score_history.length > 0) {
      const labels = snap.score_history.map((pt) => `t=${pt.tick}`);
      const totals = snap.score_history.map((pt) => pt.total);
      const revs = snap.score_history.map((pt) => pt.revenue);
      const pens = snap.score_history.map((pt) => pt.penalties);

      scoreChart.data.labels = labels;
      scoreChart.data.datasets[0].data = totals;
      scoreChart.data.datasets[1].data = revs;
      scoreChart.data.datasets[2].data = pens;
      scoreChart.update("none");
    }

    // C. Render Map Static Layer (Hanya jika Map berubah)
    if (snap.map) {
      const currentMapHash = JSON.stringify(snap.map);
      if (currentMapHash !== lastMapHash) {
        lastMapHash = currentMapHash;
        renderMapStatic(snap.map);
      }
    }

    // D. Render Map Routes Layer
    renderMapRoutes(snap.couriers, snap.orders);

    // E. Render Map Dynamic Layer (Kurir & Titik Antar)
    renderMapDynamic(snap.couriers, snap.orders);

    // F. Render Log Keputusan
    renderLogs(snap.decisions);

    // G. Render Tabel Orders
    renderOrdersTable(snap.orders, tick);

    lastTick = tick;
  }

  // 3. Render Peta Static (Zona & Restoran)
  function renderMapStatic(map) {
    if (elMapTitle && map) {
      elMapTitle.textContent = `Peta Kota Live (${map.width}×${map.height})`;
    }

    const width = map.width * CELL_SIZE;
    const height = map.height * CELL_SIZE;
    svgMap.setAttribute("viewBox", `0 0 ${width} ${height}`);

    while (gStatic.firstChild) {
      gStatic.removeChild(gStatic.firstChild);
    }

    // Render Zona
    for (const zone of map.zones) {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      const x = zone.x0 * CELL_SIZE;
      const y = zone.y0 * CELL_SIZE;
      const w = (zone.x1 - zone.x0 + 1) * CELL_SIZE;
      const h = (zone.y1 - zone.y0 + 1) * CELL_SIZE;

      rect.setAttribute("x", x);
      rect.setAttribute("y", y);
      rect.setAttribute("width", w);
      rect.setAttribute("height", h);
      rect.setAttribute(
        "fill",
        zone.weather === "rain"
          ? "rgba(56, 189, 248, 0.12)"
          : "rgba(255, 255, 255, 0.015)"
      );
      rect.setAttribute("stroke", "rgba(255, 255, 255, 0.08)");
      rect.setAttribute("stroke-width", "1");
      gStatic.appendChild(rect);

      // Label Zona
      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", x + 6);
      text.setAttribute("y", y + 14);
      text.setAttribute("fill", zone.weather === "rain" ? "#38bdf8" : "#475569");
      text.setAttribute("font-size", "10");
      text.setAttribute("font-weight", "600");
      text.textContent = `${zone.name} ${zone.weather === "rain" ? "🌧" : "☀"}`;
      gStatic.appendChild(text);
    }

    // Render Restoran
    for (const r of map.restaurants) {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const rx = r.x * CELL_SIZE;
      const ry = r.y * CELL_SIZE;

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", rx + 2);
      rect.setAttribute("y", ry + 2);
      rect.setAttribute("width", CELL_SIZE - 4);
      rect.setAttribute("height", CELL_SIZE - 4);
      rect.setAttribute("fill", "#9333ea");
      rect.setAttribute("rx", "3");

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", rx + CELL_SIZE / 2);
      label.setAttribute("y", ry + CELL_SIZE / 2 + 3);
      label.setAttribute("fill", "#fff");
      label.setAttribute("font-size", "9");
      label.setAttribute("font-weight", "bold");
      label.setAttribute("text-anchor", "middle");
      label.textContent = r.id;

      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `Restoran ${r.id} (${r.x}, ${r.y})`;

      g.appendChild(rect);
      g.appendChild(label);
      g.appendChild(title);
      gStatic.appendChild(g);
    }
  }

  // 4. Render Polyline Rute Kurir (Horizontal dulu lalu vertikal)
  function renderMapRoutes(couriers, orders) {
    while (gRoutes.firstChild) {
      gRoutes.removeChild(gRoutes.firstChild);
    }

    const ordersById = new Map(orders.map((o) => [o.id, o]));

    couriers.forEach((courier, idx) => {
      if (courier.route.length === 0) return;

      const color = COURIER_COLORS[idx % COURIER_COLORS.length];
      const points = [];

      // Titik awal kurir
      let currX = courier.x * CELL_SIZE + CELL_SIZE / 2;
      let currY = courier.y * CELL_SIZE + CELL_SIZE / 2;
      points.push(`${currX},${currY}`);

      for (const stop of courier.route) {
        const order = ordersById.get(stop.order_id);
        if (!order) continue;

        const target = stop.action === "pickup" ? order.restaurant : order.dropoff;
        const targetX = target.x * CELL_SIZE + CELL_SIZE / 2;
        const targetY = target.y * CELL_SIZE + CELL_SIZE / 2;

        // Belok siku-siku: horizontal dulu (targetX, currY), lalu vertikal (targetX, targetY)
        if (targetX !== currX) {
          points.push(`${targetX},${currY}`);
        }
        if (targetY !== currY) {
          points.push(`${targetX},${targetY}`);
        }

        currX = targetX;
        currY = targetY;
      }

      const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      polyline.setAttribute("points", points.join(" "));
      polyline.setAttribute("fill", "none");
      polyline.setAttribute("stroke", color);
      polyline.setAttribute("stroke-width", "2");
      polyline.setAttribute("stroke-dasharray", "4,3");
      polyline.setAttribute("opacity", "0.65");
      gRoutes.appendChild(polyline);
    });
  }

  // 5. Render Elemen Dynamic (Reuse Map)
  function renderMapDynamic(couriers, orders) {
    const activeIds = new Set();

    // A. Render Dropoff Order Aktif
    for (const order of orders) {
      if (order.final_status) continue; // Selesai tidak digambar
      const id = `drop_${order.id}`;
      activeIds.add(id);

      let el = dynamicSvgElements.get(id);
      if (!el) {
        el = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
        dynamicSvgElements.set(id, el);
        gDynamic.appendChild(el);
      }

      const cx = order.dropoff.x * CELL_SIZE + CELL_SIZE / 2;
      const cy = order.dropoff.y * CELL_SIZE + CELL_SIZE / 2;
      // Bentuk segitiga
      const p1 = `${cx},${cy - 5}`;
      const p2 = `${cx - 4},${cy + 4}`;
      const p3 = `${cx + 4},${cy + 4}`;
      el.setAttribute("points", `${p1} ${p2} ${p3}`);

      let fillColor = "#f87171"; // OPEN
      if (order.status === "ASSIGNED") fillColor = "#fb923c";
      if (order.status === "PICKED_UP") fillColor = "#38bdf8";

      el.setAttribute("fill", fillColor);
      el.setAttribute("stroke", "#0b0f19");
      el.setAttribute("stroke-width", "1");

      let title = el.querySelector("title");
      if (!title) {
        title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        el.appendChild(title);
      }
      title.textContent = `Order ${order.id} [${order.status}]\nDropoff: (${order.dropoff.x}, ${order.dropoff.y})\nReward: Rp ${order.reward}`;
    }

    // B. Render Kurir
    for (const courier of couriers) {
      const id = `courier_${courier.id}`;
      activeIds.add(id);

      let g = dynamicSvgElements.get(id);
      if (!g) {
        g = document.createElementNS("http://www.w3.org/2000/svg", "g");

        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("r", "8");
        circle.setAttribute("stroke", "#0f172a");
        circle.setAttribute("stroke-width", "1.5");
        circle.setAttribute("class", "c-circle");

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("font-size", "8");
        text.setAttribute("font-weight", "bold");
        text.setAttribute("fill", "#fff");
        text.setAttribute("text-anchor", "middle");
        text.setAttribute("dy", "3");
        text.setAttribute("class", "c-text");

        const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
        title.setAttribute("class", "c-title");

        g.appendChild(circle);
        g.appendChild(text);
        g.appendChild(title);

        dynamicSvgElements.set(id, g);
        gDynamic.appendChild(g);
      }

      const cx = courier.x * CELL_SIZE + CELL_SIZE / 2;
      const cy = courier.y * CELL_SIZE + CELL_SIZE / 2;
      g.setAttribute("transform", `translate(${cx}, ${cy})`);

      const circle = g.querySelector(".c-circle");
      let statusColor = "#64748b"; // idle
      if (courier.status === "moving") statusColor = "#38bdf8";
      if (courier.status === "waiting") statusColor = "#facc15";
      circle.setAttribute("fill", statusColor);

      const text = g.querySelector(".c-text");
      text.textContent = `${courier.carrying.length}/${courier.capacity}`;

      const title = g.querySelector(".c-title");
      title.textContent = `Kurir ${courier.id} (${courier.status})\nPosisi: (${courier.x}, ${courier.y})\nMuatan: ${courier.carrying.join(", ") || "kosong"}\nSisa Stop: ${courier.route.length}`;
    }

    // Hapus elemen yang sudah tidak ada
    for (const [id, el] of dynamicSvgElements.entries()) {
      if (!activeIds.has(id)) {
        if (el.parentNode) el.parentNode.removeChild(el);
        dynamicSvgElements.delete(id);
      }
    }
  }

  // 6. Render Log Keputusan Dispatcher
  function renderLogs(decisions) {
    if (!decisions || decisions.length === 0) return;

    // Ambil filter aktif
    const activeFilters = new Set();
    document.querySelectorAll(".log-filters input:checked").forEach((chk) => {
      activeFilters.add(chk.getAttribute("data-kind"));
    });

    const newDecisions = decisions.filter((d) => d.id > lastLoggedId);
    if (newDecisions.length === 0) return;

    for (const dec of newDecisions) {
      if (dec.id > lastLoggedId) lastLoggedId = dec.id;

      if (!activeFilters.has(dec.kind)) continue;

      const li = document.createElement("li");
      li.className = `log-item ${dec.kind}`;
      li.dataset.kind = dec.kind;
      li.innerHTML = `<span class="log-tick">t=${dec.tick}</span> ${escapeHtml(dec.message)}`;

      elLogList.insertBefore(li, elLogList.firstChild);
    }

    // Batasi elemen log di DOM maksimal 200 elemen
    while (elLogList.children.length > 200) {
      elLogList.removeChild(elLogList.lastChild);
    }
  }

  // 7. Render Tabel Orders
  function renderOrdersTable(orders, currentTick) {
    const showFinished = chkShowFinished.checked;
    const currentOrderIds = new Set();

    // Urutkan pesanan: risiko cancel, late, lalu sisa deadline terdekat
    const sorted = [...orders].sort((a, b) => {
      const riskWeight = { cancel: 3, late: 2, ok: 1 };
      const rA = riskWeight[a.risk] || 0;
      const rB = riskWeight[b.risk] || 0;
      if (rA !== rB) return rB - rA;
      return a.deadline_tick - b.deadline_tick;
    });

    let finishedRenderCount = 0;

    for (const o of sorted) {
      if (o.final_status) {
        if (!showFinished || finishedRenderCount >= 50) continue;
        finishedRenderCount += 1;
      }

      currentOrderIds.add(o.id);
      let tr = orderRowElements.get(o.id);

      if (!tr) {
        tr = document.createElement("tr");
        orderRowElements.set(o.id, tr);
        elOrdersTbody.appendChild(tr);
      }

      const status = o.final_status || o.status;
      const courier = o.courier_id || "-";
      const routeStr = `${o.restaurant.id} (${o.restaurant.x},${o.restaurant.y}) → (${o.dropoff.x},${o.dropoff.y})`;
      const rewardStr = rupiahFormatter.format(o.payout !== null ? o.payout : o.reward);

      let timeLeftStr = "-";
      let timeLeftClass = "";
      if (!o.final_status) {
        const remaining = o.deadline_tick - currentTick;
        timeLeftStr = `${remaining} tick`;
        if (remaining < 0) {
          timeLeftClass = "text-danger";
          timeLeftStr = `Telat ${Math.abs(remaining)} tick`;
        }
      }

      const etaStr = o.eta_dropoff !== null ? `t=${o.eta_dropoff}` : "-";

      let riskHtml = `<span class="risk-tag risk-ok">OK</span>`;
      if (o.risk === "cancel") {
        riskHtml = `<span class="risk-tag risk-cancel">RAWAN BATAL</span>`;
      } else if (o.risk === "late") {
        riskHtml = `<span class="risk-tag risk-late">TELAT</span>`;
      }

      tr.innerHTML = `
        <td><strong>${o.id}</strong> ${o.premium ? '<span style="color:#facc15">★</span>' : ""}</td>
        <td><span class="badge-status status-${status}">${status}</span></td>
        <td><strong>${courier}</strong></td>
        <td>${routeStr}</td>
        <td>${rewardStr}</td>
        <td class="${timeLeftClass}">${timeLeftStr}</td>
        <td>${etaStr}</td>
        <td>${riskHtml}</td>
      `;
    }

    // Bersihkan baris yang sudah tidak ada di tampilan
    for (const [id, tr] of orderRowElements.entries()) {
      if (!currentOrderIds.has(id)) {
        if (tr.parentNode) tr.parentNode.removeChild(tr);
        orderRowElements.delete(id);
      }
    }
  }

  function escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // 8. EventSource (SSE Connection)
  function initEventSource() {
    const es = new EventSource("/api/stream");

    es.onopen = () => {
      elConn.textContent = "Live";
      elConn.className = "status-badge connected";
    };

    es.onerror = () => {
      elConn.textContent = "Terputus, mencoba lagi…";
      elConn.className = "status-badge disconnected";
    };

    es.addEventListener("snapshot", (e) => {
      try {
        const snap = JSON.parse(e.data);
        latestSnapshot = snap;
        scheduleRender();
      } catch (err) {
        console.error("Gagal parse snapshot SSE:", err);
      }
    });
  }

  // 9. Tombol Practice Run Baru
  elBtnPractice.addEventListener("click", async () => {
    const seedVal = elSeed.value ? parseInt(elSeed.value, 10) : undefined;
    elBtnPractice.disabled = true;
    elBtnPractice.textContent = "Memulai...";

    try {
      const res = await fetch("/api/practice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seedVal !== undefined ? { seed: seedVal } : {}),
      });
      const data = await res.json();
      if (data.ok) {
        console.log("Practice run baru dimulai:", data);
      }
    } catch (err) {
      alert("Gagal memulai run baru: " + err.message);
    } finally {
      elBtnPractice.disabled = false;
      elBtnPractice.textContent = "Run Baru";
    }
  });

  // Re-render saat filter diubah
  document.querySelectorAll(".log-filters input").forEach((chk) => {
    chk.addEventListener("change", () => {
      lastLoggedId = 0;
      elLogList.innerHTML = "";
      if (latestSnapshot) renderLogs(latestSnapshot.decisions);
    });
  });

  chkShowFinished.addEventListener("change", () => {
    if (latestSnapshot) {
      renderOrdersTable(latestSnapshot.orders, latestSnapshot.run ? latestSnapshot.run.tick : 0);
    }
  });

  // Start Connection
  initEventSource();
})();
