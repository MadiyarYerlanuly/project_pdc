/* Mini-Spark — tiny dependency-free SVG charts (the demo laptop may be offline,
 * so no CDN libraries). Colors come from CSS custom properties. */
window.MS = window.MS || {};

(function () {
  const r1 = (v) => Math.round(v * 10) / 10;

  MS.sparkline = function (values, w, h) {
    const vals = values.length ? values : [0];
    const max = Math.max(1, ...vals) * 1.1;
    const step = vals.length > 1 ? w / (vals.length - 1) : w;
    const pts = vals.map((v, i) => [r1(i * step), r1(h - (v / max) * (h - 4) - 2)]);
    const line = pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
    const area = line + ` L${pts[pts.length - 1][0]} ${h} L0 ${h} Z`;
    return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" class="spark" aria-hidden="true">
      <defs><linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--teal)" stop-opacity=".35"/><stop offset="1" stop-color="var(--teal)" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#sparkFill)"/>
      <path d="${line}" fill="none" stroke="var(--teal)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>`;
  };

  /* Horizontal bars on a log scale — Serial 2.38 vs GPU 197 MH/s fits on one axis */
  MS.barChartLog = function (rows) {
    const w = 1040, rowH = 46, padL = 150, padR = 170, h = rows.length * rowH + 28;
    const maxLog = Math.log10(Math.max(...rows.map((r) => r.mhs)) * 1.6);
    const minLog = 0; // 1 MH/s
    const x = (v) => padL + ((Math.log10(Math.max(v, 1)) - minLog) / (maxLog - minLog)) * (w - padL - padR);
    let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="Throughput by compute backend, log scale">`;
    [1, 10, 100].forEach((t) => {
      if (Math.log10(t) > maxLog) return;
      s += `<line x1="${x(t)}" y1="6" x2="${x(t)}" y2="${h - 22}" class="grid"/>
            <text x="${x(t)}" y="${h - 6}" class="axis" text-anchor="middle">${t} MH/s</text>`;
    });
    rows.forEach((r, i) => {
      const y = 10 + i * rowH;
      const gpu = /GPU/.test(r.label);
      s += `<text x="0" y="${y + 15}" class="lbl">${r.label}</text>
            <text x="0" y="${y + 30}" class="sub">${r.detail}</text>
            <rect x="${padL}" y="${y + 6}" width="${Math.max(4, x(r.mhs) - padL)}" height="22" rx="8" class="${gpu ? "bar-gpu" : "bar-cpu"}"/>
            <text x="${x(r.mhs) + 8}" y="${y + 18}" class="val">${r.mhs.toFixed(2)}</text>
            <text x="${x(r.mhs) + 8}" y="${y + 31}" class="sub">${r.speedup.toFixed(r.speedup >= 10 ? 1 : 2)}× · CPU ${r.cpuLoad}%</text>`;
    });
    return s + "</svg>";
  };

  /* Line chart: { xs, series:[{values, cls, label}], yMax, yMin, yFmt, xFmt, ref:{y,label} } */
  MS.lineChart = function (o) {
    const w = 520, h = 260, padL = 44, padR = 16, padT = 18, padB = 36;
    const xMin = Math.min(...o.xs), xMax = Math.max(...o.xs);
    const yMin = o.yMin ?? 0, yMax = o.yMax;
    const X = (v) => padL + ((v - xMin) / (xMax - xMin || 1)) * (w - padL - padR);
    const Y = (v) => padT + (1 - (v - yMin) / (yMax - yMin)) * (h - padT - padB);
    let s = `<svg viewBox="0 0 ${w} ${h}" class="chart" role="img" aria-label="${MS.esc(o.aria || "chart")}">`;
    (o.yTicks || []).forEach((t) => {
      s += `<line x1="${padL}" y1="${Y(t)}" x2="${w - padR}" y2="${Y(t)}" class="grid"/>
            <text x="${padL - 8}" y="${Y(t) + 4}" class="axis" text-anchor="end">${o.yFmt ? o.yFmt(t) : t}</text>`;
    });
    o.xs.forEach((v) => {
      s += `<text x="${X(v)}" y="${h - 14}" class="axis" text-anchor="middle">${o.xFmt ? o.xFmt(v) : v}</text>`;
    });
    if (o.xLabel) s += `<text x="${(padL + w - padR) / 2}" y="${h - 1}" class="axis" text-anchor="middle">${o.xLabel}</text>`;
    if (o.ref) {
      s += `<line x1="${padL}" y1="${Y(o.ref.y)}" x2="${w - padR}" y2="${Y(o.ref.y)}" class="ref"/>
            <text x="${w - padR}" y="${Y(o.ref.y) - 6}" class="ref-lbl" text-anchor="end">${o.ref.label}</text>`;
    }
    o.series.forEach((ser) => {
      const d = ser.values.map((v, i) => (i ? "L" : "M") + r1(X(o.xs[i])) + " " + r1(Y(v))).join(" ");
      s += `<path d="${d}" class="ln ${ser.cls}"/>`;
      if (!ser.noDots)
        ser.values.forEach((v, i) => {
          s += `<circle cx="${r1(X(o.xs[i]))}" cy="${r1(Y(v))}" r="4.5" class="dot ${ser.cls}"/>`;
          if (ser.labels) s += `<text x="${r1(X(o.xs[i]))}" y="${r1(Y(v)) - 11}" class="pt-lbl" text-anchor="middle">${ser.labels[i]}</text>`;
        });
    });
    return s + "</svg>";
  };
})();
