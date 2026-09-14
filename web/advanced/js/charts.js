(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.DecisionCharts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";
  const palette = ["#7357d8", "#188f82", "#dc6b50", "#b67b2e", "#8a647a", "#5f7772", "#a45669"];

  function node(name, attrs = {}, text = null) {
    const element = document.createElementNS(NS, name);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value != null) element.setAttribute(key, String(value));
    });
    if (text != null) element.textContent = text;
    return element;
  }

  function svg(container, width, height, label) {
    container.innerHTML = "";
    container.classList.remove("empty-chart", "chart-empty");
    const chart = node("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": label || "数据图表", class: "chart-svg" });
    container.appendChild(chart);
    return chart;
  }

  function empty(container, message) {
    container.innerHTML = `<div class="chart-empty">${escapeHTML(message || "当前数据不足，无法生成图表")}</div>`;
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  }

  function format(value, digits = 2) {
    if (!Number.isFinite(value)) return "NA";
    return Number(value).toFixed(digits).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
  }

  function niceTicks(min, max, count = 5) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min || 0];
    const raw = (max - min) / count;
    const power = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / power;
    const step = (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * power;
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let value = start; value <= max + step * 0.01; value += step) ticks.push(Number(value.toFixed(12)));
    return ticks;
  }

  function colorDiverging(value, min = -1, max = 1) {
    if (!Number.isFinite(value)) return "#efede9";
    const zero = min < 0 && max > 0 ? (0 - min) / (max - min) : 0.5;
    const t = (value - min) / (max - min || 1);
    let a;
    let b;
    let u;
    if (t < zero) {
      a = [94, 126, 119]; b = [249, 248, 245]; u = zero ? t / zero : 0;
    } else {
      a = [249, 248, 245]; b = [211, 99, 78]; u = (t - zero) / (1 - zero || 1);
    }
    const rgb = a.map((start, index) => Math.round(start + (b[index] - start) * Math.max(0, Math.min(1, u))));
    return `rgb(${rgb.join(",")})`;
  }

  function addTitle(element, text) {
    element.appendChild(node("title", {}, text));
  }

  function barScatter(container, data, options = {}) {
    if (!data || !data.length || !data.some((row) => Number.isFinite(row.mean))) return empty(container, options.empty || "没有满足覆盖要求的条件效应");
    const width = Math.max(740, Math.min(1180, data.length * 120 + 130));
    const height = options.height || 440;
    const margin = { top: 38, right: 32, bottom: 118, left: 64 };
    const chart = svg(container, width, height, options.label || "均值、题组散点和置信区间图");
    const values = data.flatMap((row) => [row.mean, row.ciLow, row.ciHigh, ...(row.points || [])]).filter(Number.isFinite);
    const min = options.min != null ? options.min : Math.min(-0.1, ...values);
    const max = options.max != null ? options.max : Math.max(0.1, ...values);
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const y = (value) => margin.top + (max - value) / (max - min || 1) * innerH;
    const ticks = niceTicks(min, max, 6);
    ticks.forEach((tick) => {
      chart.appendChild(node("line", { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: Math.abs(tick) < 1e-10 ? "zero-line" : "grid-line" }));
      chart.appendChild(node("text", { x: margin.left - 9, y: y(tick) + 3, "text-anchor": "end" }, format(tick, 2)));
    });
    const band = innerW / data.length;
    const barW = Math.min(72, band * 0.58);
    data.forEach((row, index) => {
      const cx = margin.left + band * (index + 0.5);
      const color = row.color || palette[index % palette.length];
      const meanValue = row.mean;
      if (Number.isFinite(meanValue)) {
        const y0 = y(0);
        const ym = y(meanValue);
        const rect = node("rect", { x: cx - barW / 2, y: Math.min(y0, ym), width: barW, height: Math.max(1, Math.abs(y0 - ym)), rx: 3, fill: color, opacity: 0.72 });
        addTitle(rect, `${row.label}: ${format(meanValue, 3)}`);
        chart.appendChild(rect);
        if (Number.isFinite(row.ciLow) && Number.isFinite(row.ciHigh)) {
          chart.appendChild(node("line", { x1: cx, x2: cx, y1: y(row.ciHigh), y2: y(row.ciLow), stroke: "#39323e", "stroke-width": 1.2 }));
          chart.appendChild(node("line", { x1: cx - 7, x2: cx + 7, y1: y(row.ciHigh), y2: y(row.ciHigh), stroke: "#39323e", "stroke-width": 1.2 }));
          chart.appendChild(node("line", { x1: cx - 7, x2: cx + 7, y1: y(row.ciLow), y2: y(row.ciLow), stroke: "#39323e", "stroke-width": 1.2 }));
        }
      }
      (row.points || []).forEach((point, pointIndex) => {
        if (!Number.isFinite(point)) return;
        const jitter = ((((pointIndex + 1) * 37 + index * 17) % 19) - 9) / 9 * Math.min(26, barW * 0.48);
        const dot = node("circle", { cx: cx + jitter, cy: y(point), r: 2.4, fill: "#332f36", opacity: 0.64 });
        addTitle(dot, `${row.label} · 题组值 ${format(point, 3)}`);
        chart.appendChild(dot);
      });
      if (row.significance) chart.appendChild(node("text", { x: cx, y: Math.max(18, y(Number.isFinite(row.ciHigh) ? row.ciHigh : row.mean) - 12), "text-anchor": "middle", fill: "#bc4550", "font-weight": 800 }, row.significance));
      const label = String(row.shortLabel || row.label);
      const text = node("text", { transform: `translate(${cx - 2} ${height - margin.bottom + 18}) rotate(-36)`, "text-anchor": "end" });
      text.textContent = label.length > 24 ? label.slice(0, 23) + "…" : label;
      addTitle(text, label);
      chart.appendChild(text);
    });
    chart.appendChild(node("line", { x1: margin.left, x2: width - margin.right, y1: margin.top + innerH, y2: margin.top + innerH, class: "axis-line" }));
  }

  function horizontalBars(container, data, options = {}) {
    const rows = (data || []).filter((row) => Number.isFinite(row.value));
    if (!rows.length) return empty(container, options.empty || "没有可绘制的数值");
    const width = options.width || 820;
    const rowHeight = options.rowHeight || 31;
    const height = Math.max(230, 70 + rows.length * rowHeight);
    const margin = { top: 28, right: 50, bottom: 36, left: options.left || 190 };
    const chart = svg(container, width, height, options.label || "横向效应排序图");
    const values = rows.map((row) => row.value);
    const min = options.min != null ? options.min : Math.min(0, ...values);
    const max = options.max != null ? options.max : Math.max(0, ...values);
    const innerW = width - margin.left - margin.right;
    const x = (value) => margin.left + (value - min) / (max - min || 1) * innerW;
    niceTicks(min, max, 5).forEach((tick) => {
      chart.appendChild(node("line", { x1: x(tick), x2: x(tick), y1: margin.top, y2: height - margin.bottom, class: Math.abs(tick) < 1e-10 ? "zero-line" : "grid-line" }));
      chart.appendChild(node("text", { x: x(tick), y: height - 12, "text-anchor": "middle" }, format(tick, 2)));
    });
    rows.forEach((row, index) => {
      const y = margin.top + index * rowHeight + 5;
      const x0 = x(0);
      const xv = x(row.value);
      const color = row.color || (row.value >= 0 ? "#dc6b50" : "#7357d8");
      const rect = node("rect", { x: Math.min(x0, xv), y, width: Math.max(1, Math.abs(xv - x0)), height: 15, rx: 2, fill: color, opacity: 0.84 });
      addTitle(rect, `${row.label}: ${format(row.value, 3)}`);
      chart.appendChild(rect);
      const label = String(row.label);
      const labelNode = node("text", { x: margin.left - 9, y: y + 11, "text-anchor": "end" }, label.length > 30 ? label.slice(0, 29) + "…" : label);
      addTitle(labelNode, label);
      chart.appendChild(labelNode);
      chart.appendChild(node("text", { x: row.value >= 0 ? xv + 6 : xv - 6, y: y + 11, "text-anchor": row.value >= 0 ? "start" : "end", fill: "#3f3943", "font-weight": 700 }, format(row.value, 3)));
    });
  }

  function radar(container, axes, series, options = {}) {
    const axisRows = (axes || []).filter((axis) => axis && axis.label);
    const lineRows = (series || []).filter((line) => Array.isArray(line.values) && line.values.some(Number.isFinite));
    if (axisRows.length < 3 || !lineRows.length) return empty(container, options.empty || "至少需要 3 个可比维度才能生成雷达画像");
    const width = 760;
    const height = 540;
    const cx = 380;
    const cy = 260;
    const radius = 178;
    const chart = svg(container, width, height, options.label || "多维偏好雷达图");
    const angle = (index) => -Math.PI / 2 + index * 2 * Math.PI / axisRows.length;
    const point = (index, value) => [cx + Math.cos(angle(index)) * radius * value, cy + Math.sin(angle(index)) * radius * value];
    [0.2, 0.4, 0.6, 0.8, 1].forEach((level) => {
      const points = axisRows.map((_, index) => point(index, level).join(",")).join(" ");
      chart.appendChild(node("polygon", { points, fill: level === 1 ? "#faf9f7" : "none", stroke: "#ded9d2", "stroke-width": 1 }));
      chart.appendChild(node("text", { x: cx + 4, y: cy - radius * level + 11, fill: "#9aa5ad", "font-size": 8 }, format(level, 1)));
    });
    axisRows.forEach((axis, index) => {
      const [x, y] = point(index, 1);
      chart.appendChild(node("line", { x1: cx, y1: cy, x2: x, y2: y, stroke: "#ded9d2" }));
      const labelPoint = point(index, 1.17);
      const anchor = Math.cos(angle(index)) > 0.2 ? "start" : Math.cos(angle(index)) < -0.2 ? "end" : "middle";
      const label = String(axis.label);
      const labelNode = node("text", { x: labelPoint[0], y: labelPoint[1], "text-anchor": anchor, "dominant-baseline": "middle", fill: "#4c4650", "font-size": 10, "font-weight": 650 }, label.length > 13 ? label.slice(0, 12) + "…" : label);
      addTitle(labelNode, label);
      chart.appendChild(labelNode);
    });
    lineRows.forEach((line, seriesIndex) => {
      const color = line.color || palette[seriesIndex % palette.length];
      const values = axisRows.map((axis, index) => {
        const value = Number.isFinite(line.values[index]) ? line.values[index] : 0;
        return Math.max(0, Math.min(1, value));
      });
      const points = values.map((value, index) => point(index, value).join(",")).join(" ");
      const polygon = node("polygon", { points, fill: color, "fill-opacity": 0.08, stroke: color, "stroke-width": 2.2 });
      addTitle(polygon, line.label);
      chart.appendChild(polygon);
      values.forEach((value, index) => {
        const [x, y] = point(index, value);
        const dot = node("circle", { cx: x, cy: y, r: 3.2, fill: "white", stroke: color, "stroke-width": 2 });
        const raw = line.rawValues && Number.isFinite(line.rawValues[index]) ? `；原始值 ${format(line.rawValues[index], 3)}` : "";
        addTitle(dot, `${line.label} · ${axisRows[index].label}: ${format(value, 3)}${raw}`);
        chart.appendChild(dot);
      });
    });
    const legendY = height - 28;
    lineRows.forEach((line, index) => {
      const x = 48 + index * Math.min(190, (width - 80) / lineRows.length);
      const color = line.color || palette[index % palette.length];
      chart.appendChild(node("line", { x1: x, x2: x + 24, y1: legendY, y2: legendY, stroke: color, "stroke-width": 3 }));
      chart.appendChild(node("text", { x: x + 31, y: legendY + 3, fill: "#59535e", "font-size": 9 }, String(line.label).slice(0, 24)));
    });
  }

  function heatmap(container, rowLabels, colLabels, matrix, options = {}) {
    if (!rowLabels || !colLabels || rowLabels.length === 0 || colLabels.length === 0) return empty(container, options.empty || "当前筛选没有可绘制的矩阵");
    const cell = Math.max(18, Math.min(42, options.cell || 34));
    const left = Math.max(130, Math.min(245, Math.max(...rowLabels.map((label) => String(label).length)) * 10));
    const top = Math.max(105, Math.min(210, Math.max(...colLabels.map((label) => String(label).length)) * 7));
    const width = Math.max(620, left + colLabels.length * cell + 80);
    const height = Math.max(280, top + rowLabels.length * cell + 60);
    const chart = svg(container, width, height, options.label || "数据热力图");
    const min = options.min != null ? options.min : -1;
    const max = options.max != null ? options.max : 1;
    colLabels.forEach((label, colIndex) => {
      const x = left + colIndex * cell + cell * 0.58;
      const text = node("text", { transform: `translate(${x} ${top - 10}) rotate(-45)`, "text-anchor": "start", fill: "#625c66", "font-size": 9 }, String(label).length > 20 ? String(label).slice(0, 19) + "…" : label);
      addTitle(text, label);
      chart.appendChild(text);
    });
    rowLabels.forEach((label, rowIndex) => {
      const y = top + rowIndex * cell;
      const text = node("text", { x: left - 9, y: y + cell * 0.62, "text-anchor": "end", fill: "#625c66", "font-size": 9 }, String(label).length > 27 ? String(label).slice(0, 26) + "…" : label);
      addTitle(text, label);
      chart.appendChild(text);
      colLabels.forEach((colLabel, colIndex) => {
        const value = matrix[rowIndex] ? matrix[rowIndex][colIndex] : null;
        const rect = node("rect", { x: left + colIndex * cell, y, width: cell - 1, height: cell - 1, rx: 1.5, fill: options.color ? options.color(value) : colorDiverging(value, min, max), stroke: "#ffffff", "stroke-width": 0.7 });
        addTitle(rect, `${label} × ${colLabel}: ${format(value, 3)}`);
        chart.appendChild(rect);
        if (cell >= 34 && Number.isFinite(value)) chart.appendChild(node("text", { x: left + colIndex * cell + cell / 2, y: y + cell * 0.62, "text-anchor": "middle", fill: Math.abs(value) > 0.55 ? "white" : "#3f3943", "font-size": 8 }, format(value, 2)));
      });
    });
    const legendX = width - 44;
    const legendY = top;
    const legendH = Math.min(180, rowLabels.length * cell);
    for (let i = 0; i < 40; i += 1) {
      const value = max - (max - min) * i / 39;
      chart.appendChild(node("rect", { x: legendX, y: legendY + i * legendH / 40, width: 10, height: legendH / 40 + 0.6, fill: options.color ? options.color(value) : colorDiverging(value, min, max) }));
    }
    chart.appendChild(node("text", { x: legendX + 16, y: legendY + 7, fill: "#697986", "font-size": 8 }, format(max, 1)));
    chart.appendChild(node("text", { x: legendX + 16, y: legendY + legendH, fill: "#697986", "font-size": 8 }, format(min, 1)));
  }

  function donut(container, items, options = {}) {
    const rows = (items || []).filter((item) => Number.isFinite(item.value) && item.value > 0);
    const total = rows.reduce((sum, row) => sum + row.value, 0);
    if (!total) return empty(container, options.empty || "没有可统计的状态记录");
    const width = 620;
    const height = 300;
    const chart = svg(container, width, height, options.label || "状态构成环形图");
    const cx = 168;
    const cy = 145;
    const radius = 88;
    const circumference = 2 * Math.PI * radius;
    let offset = 0;
    rows.forEach((row, index) => {
      const fraction = row.value / total;
      const circle = node("circle", { cx, cy, r: radius, fill: "none", stroke: row.color || palette[index % palette.length], "stroke-width": 30, "stroke-dasharray": `${fraction * circumference} ${circumference}`, "stroke-dashoffset": -offset * circumference, transform: `rotate(-90 ${cx} ${cy})` });
      addTitle(circle, `${row.label}: ${row.value} (${format(fraction * 100, 1)}%)`);
      chart.appendChild(circle);
      offset += fraction;
    });
    chart.appendChild(node("circle", { cx, cy, r: 58, fill: "white" }));
    chart.appendChild(node("text", { x: cx, y: cy - 4, "text-anchor": "middle", fill: "#2b2630", "font-size": 27, "font-family": "Georgia", "font-weight": 600 }, String(total)));
    chart.appendChild(node("text", { x: cx, y: cy + 17, "text-anchor": "middle", fill: "#83909a", "font-size": 9 }, options.centerLabel || "记录"));
    rows.forEach((row, index) => {
      const y = 62 + index * 34;
      chart.appendChild(node("rect", { x: 325, y: y - 9, width: 10, height: 10, rx: 2, fill: row.color || palette[index % palette.length] }));
      chart.appendChild(node("text", { x: 344, y, fill: "#59535e", "font-size": 10 }, row.label));
      chart.appendChild(node("text", { x: 555, y, "text-anchor": "end", fill: "#3f3943", "font-size": 10, "font-weight": 700 }, `${row.value} · ${format(row.value / total * 100, 1)}%`));
    });
  }

  function stackedBars(container, rows, segments, options = {}) {
    if (!rows || !rows.length) return empty(container, options.empty || "没有可绘制的分组分布");
    const width = 780;
    const rowHeight = 43;
    const height = Math.max(260, 80 + rows.length * rowHeight);
    const left = 180;
    const right = 50;
    const chart = svg(container, width, height, options.label || "逻辑首选构成图");
    const innerW = width - left - right;
    rows.forEach((row, rowIndex) => {
      const y = 32 + rowIndex * rowHeight;
      const total = segments.reduce((sum, segment) => sum + (Number(row.values[segment.key]) || 0), 0) || 1;
      let x = left;
      segments.forEach((segment) => {
        const value = Number(row.values[segment.key]) || 0;
        const fraction = value / total;
        const rect = node("rect", { x, y, width: Math.max(0, innerW * fraction), height: 20, fill: segment.color, rx: fraction > 0.98 ? 4 : 0 });
        addTitle(rect, `${row.label} · ${segment.label}: ${format(fraction * 100, 1)}%`);
        chart.appendChild(rect);
        if (fraction > 0.08) chart.appendChild(node("text", { x: x + innerW * fraction / 2, y: y + 14, "text-anchor": "middle", fill: "white", "font-size": 8, "font-weight": 700 }, `${format(fraction * 100, 0)}%`));
        x += innerW * fraction;
      });
      const label = String(row.label);
      const text = node("text", { x: left - 9, y: y + 14, "text-anchor": "end", fill: "#59535e", "font-size": 9 }, label.length > 25 ? label.slice(0, 24) + "…" : label);
      addTitle(text, label);
      chart.appendChild(text);
    });
    let legendX = left;
    segments.forEach((segment) => {
      chart.appendChild(node("rect", { x: legendX, y: height - 24, width: 9, height: 9, rx: 2, fill: segment.color }));
      chart.appendChild(node("text", { x: legendX + 14, y: height - 16, fill: "#60707d", "font-size": 8 }, segment.label));
      legendX += 110;
    });
  }

  function multiLine(container, xLabels, series, options = {}) {
    const labels = xLabels || [];
    const rows = (series || []).filter((row) => Array.isArray(row.values) && row.values.some(Number.isFinite));
    if (labels.length < 2 || !rows.length) return empty(container, options.empty || "当前没有可绘制的因子趋势");
    const width = 860;
    const height = options.height || 430;
    const margin = { top: 42, right: 38, bottom: 94, left: 64 };
    const chart = svg(container, width, height, options.label || "因子简单效应折线图");
    const min = options.min != null ? options.min : -1;
    const max = options.max != null ? options.max : 1;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const x = (index) => margin.left + (labels.length === 1 ? innerW / 2 : index * innerW / (labels.length - 1));
    const y = (value) => margin.top + (max - value) / (max - min || 1) * innerH;
    niceTicks(min, max, 6).forEach((tick) => {
      chart.appendChild(node("line", { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: Math.abs(tick) < 1e-10 ? "zero-line" : "grid-line" }));
      chart.appendChild(node("text", { x: margin.left - 9, y: y(tick) + 3, "text-anchor": "end" }, format(tick, 2)));
    });
    labels.forEach((label, index) => {
      chart.appendChild(node("line", { x1: x(index), x2: x(index), y1: margin.top, y2: margin.top + innerH, class: "grid-line", opacity: 0.45 }));
      const text = node("text", { transform: `translate(${x(index)} ${height - margin.bottom + 20}) rotate(-30)`, "text-anchor": "end", fill: "#625c66", "font-size": 9 }, String(label).length > 22 ? `${String(label).slice(0, 21)}…` : String(label));
      addTitle(text, label);
      chart.appendChild(text);
    });
    rows.forEach((row, rowIndex) => {
      const color = row.color || palette[rowIndex % palette.length];
      let segment = [];
      const flush = () => {
        if (segment.length > 1) chart.appendChild(node("polyline", { points: segment.join(" "), fill: "none", stroke: color, "stroke-width": 2.4, "stroke-linejoin": "round", "stroke-linecap": "round" }));
        segment = [];
      };
      row.values.forEach((value, index) => {
        if (!Number.isFinite(value)) { flush(); return; }
        segment.push(`${x(index)},${y(value)}`);
        const dot = node("circle", { cx: x(index), cy: y(value), r: 4, fill: "white", stroke: color, "stroke-width": 2.3 });
        addTitle(dot, `${row.label} · ${labels[index]}: ${format(value, 3)}`);
        chart.appendChild(dot);
      });
      flush();
      const legendX = margin.left + rowIndex * Math.min(210, innerW / Math.max(1, rows.length));
      chart.appendChild(node("line", { x1: legendX, x2: legendX + 24, y1: 22, y2: 22, stroke: color, "stroke-width": 3 }));
      chart.appendChild(node("text", { x: legendX + 31, y: 25, fill: "#59535e", "font-size": 9 }, String(row.label).slice(0, 28)));
    });
    chart.appendChild(node("line", { x1: margin.left, x2: width - margin.right, y1: margin.top + innerH, y2: margin.top + innerH, class: "axis-line" }));
  }

  function numericMultiLine(container, series, options = {}) {
    const rows = (series || []).map((row) => ({ ...row, points: (row.points || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).sort((a, b) => a.x - b.x) })).filter((row) => row.points.length);
    const points = rows.flatMap((row) => row.points);
    if (!points.length) return empty(container, options.empty || "当前没有可绘制的数值型因子趋势");
    const width = 880;
    const height = options.height || 430;
    const margin = { top: 46, right: 38, bottom: 72, left: 70 };
    const chart = svg(container, width, height, options.label || "数值型因子简单斜率图");
    const rawMinX = Math.min(...points.map((point) => point.x));
    const rawMaxX = Math.max(...points.map((point) => point.x));
    const minX = options.minX != null ? options.minX : rawMinX;
    const maxX = options.maxX != null ? options.maxX : rawMaxX;
    const minY = options.min != null ? options.min : Math.min(-0.05, ...points.map((point) => point.y));
    const maxY = options.max != null ? options.max : Math.max(0.05, ...points.map((point) => point.y));
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const x = (value) => margin.left + (value - minX) / (maxX - minX || 1) * innerW;
    const y = (value) => margin.top + (maxY - value) / (maxY - minY || 1) * innerH;
    niceTicks(minY, maxY, 6).forEach((tick) => {
      chart.appendChild(node("line", { x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: Math.abs(tick) < 1e-10 ? "zero-line" : "grid-line" }));
      chart.appendChild(node("text", { x: margin.left - 9, y: y(tick) + 3, "text-anchor": "end" }, format(tick, 2)));
    });
    niceTicks(minX, maxX, 7).forEach((tick) => {
      chart.appendChild(node("line", { x1: x(tick), x2: x(tick), y1: margin.top, y2: margin.top + innerH, class: "grid-line", opacity: 0.42 }));
      chart.appendChild(node("text", { x: x(tick), y: height - margin.bottom + 22, "text-anchor": "middle", fill: "#625c66", "font-size": 9 }, format(tick, options.xDigits == null ? 2 : options.xDigits)));
    });
    if (Number.isFinite(options.referenceX) && options.referenceX >= minX && options.referenceX <= maxX) {
      chart.appendChild(node("line", { x1: x(options.referenceX), x2: x(options.referenceX), y1: margin.top, y2: margin.top + innerH, stroke: "#b67b2e", "stroke-width": 1.5, "stroke-dasharray": "5 4" }));
      chart.appendChild(node("text", { x: x(options.referenceX) + 5, y: margin.top + 11, fill: "#91601d", "font-size": 9 }, `${options.referenceLabel || "参考点"} ${format(options.referenceX, 2)}`));
    }
    rows.forEach((row, rowIndex) => {
      const color = row.color || palette[rowIndex % palette.length];
      const polyline = node("polyline", { points: row.points.map((point) => `${x(point.x)},${y(point.y)}`).join(" "), fill: "none", stroke: color, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" });
      addTitle(polyline, row.label);
      chart.appendChild(polyline);
      row.points.forEach((point) => {
        const dot = node("circle", { cx: x(point.x), cy: y(point.y), r: 4, fill: "white", stroke: color, "stroke-width": 2.3 });
        addTitle(dot, `${row.label} · x=${format(point.x, 3)} · y=${format(point.y, 3)}`);
        chart.appendChild(dot);
      });
      const legendX = margin.left + rowIndex * Math.min(230, innerW / Math.max(1, rows.length));
      chart.appendChild(node("line", { x1: legendX, x2: legendX + 24, y1: 23, y2: 23, stroke: color, "stroke-width": 3 }));
      chart.appendChild(node("text", { x: legendX + 31, y: 26, fill: "#59535e", "font-size": 9 }, String(row.label).slice(0, 30)));
    });
    chart.appendChild(node("line", { x1: margin.left, x2: width - margin.right, y1: margin.top + innerH, y2: margin.top + innerH, class: "axis-line" }));
    chart.appendChild(node("text", { x: width / 2, y: height - 14, "text-anchor": "middle", fill: "#59535e", "font-size": 10, "font-weight": 650 }, options.xLabel || "数值因子"));
  }

  return { barScatter, horizontalBars, radar, heatmap, donut, stackedBars, multiLine, numericMultiLine, empty, format, palette, colorDiverging, escapeHTML };
});
