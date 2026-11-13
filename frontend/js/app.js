/* Mini-Spark — UI controller. Talks only to the backend interface in api.js. */
(function () {
  const $ = (id) => document.getElementById(id);
  const ST = MS.ChunkStatus;
  const NODE_COLORS = ["#00B8A9", "#2E9BFF", "#A855F7", "#7CB518", "#E0569B"]; // indigo is reserved for the Master
  const MAX_CHUNKS = 4096;

  const app = {
    backend: null,
    snap: null,
    target: { mode: "hash", hash: "", label: "" },
    colorOf: {},
    hbSeen: {},
    stripCells: [],
    stripKey: "",
    topoKey: "",
    cardsKey: "",
    recKey: "",
    logKey: "",
    resultShown: "",
    pollTimer: null,
    busy: false,
  };

  /* ================================================================ helpers */
  function toast(msg, kind) {
    const el = document.createElement("div");
    el.className = "toast " + (kind || "");
    el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }
  async function act(fn) {
    if (app.busy) return;
    app.busy = true;
    try {
      const r = await fn();
      if (r && r.job) app.snap = r;
      await refresh();
    } catch (e) {
      toast(e.message || String(e), "err");
    } finally {
      app.busy = false;
    }
  }
  function color(id) {
    if (!app.colorOf[id]) app.colorOf[id] = NODE_COLORS[Object.keys(app.colorOf).length % NODE_COLORS.length];
    return app.colorOf[id];
  }
  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  const nodeById = (id) => (app.snap ? app.snap.nodes.find((n) => n.id === id) : null);
  const isLive = () => app.backend && app.backend.mode === "live";
  const deviceLabel = (n) => {
    if (n.server && n.role === "master") return "coordinator · master.py";
    if (n.mode === "gpu") return n.deviceLabel || (MS.DEVICES[n.device] || { label: n.device }).label;
    return `${n.threadsAllowed}/${n.cpuThreads} threads`;
  };
  /* expected MH/s: live = measured by the worker, demo = device catalog */
  const nodeEstimate = (n) => (n.role === "master" ? 0 : isLive() ? n.estMhs || 0 : MS.estimateNodeMhs ? MS.estimateNodeMhs(n) : 0);

  /* ================================================================ tabs */
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
      document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + t.dataset.view));
      if (t.dataset.view === "bench") renderBench();
      if (t.dataset.view === "nodes") { app.cardsKey = ""; renderCards(); }
    })
  );

  /* ================================================================ job form */
  const lenInput = $("lenInput"), chunkInput = $("chunkInput"), hashInput = $("hashInput"), testPw = $("testPw");

  document.querySelectorAll("#targetSeg button").forEach((b) =>
    b.addEventListener("click", () => {
      app.target.mode = b.dataset.t;
      document.querySelectorAll("#targetSeg button").forEach((x) => x.classList.toggle("active", x === b));
      document.querySelectorAll(".tpanel").forEach((p) => p.classList.toggle("active", p.dataset.t === b.dataset.t));
      updateTarget();
    })
  );

  hashInput.addEventListener("input", updateTarget);
  testPw.addEventListener("input", () => {
    testPw.value = testPw.value.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, MS.MAX_LEN);
    if (testPw.value) lenInput.value = testPw.value.length;
    updateTarget();
  });
  $("randPw").addEventListener("click", () => {
    const L = +lenInput.value;
    let s = "";
    for (let i = 0; i < L; i++) s += MS.CHARSET[Math.floor(Math.random() * 36)];
    testPw.value = s;
    updateTarget();
  });
  lenInput.addEventListener("input", () => {
    if (app.target.mode === "test" && testPw.value && testPw.value.length !== +lenInput.value) {
      testPw.value = testPw.value.slice(0, +lenInput.value);
      updateTarget();
    }
    updateKeyspace();
  });
  chunkInput.addEventListener("change", updateKeyspace);

  // file target
  const drop = $("dropZone"), fileInput = $("fileInput");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => e.dataTransfer.files[0] && hashFile(e.dataTransfer.files[0]));
  fileInput.addEventListener("change", () => fileInput.files[0] && hashFile(fileInput.files[0]));
  async function hashFile(file) {
    $("dropTitle").textContent = file.name;
    $("dropSub").textContent = "Hashing " + MS.fmtCompact(file.size) + "B…";
    try {
      const h = await app.backend.hashFile(file);
      app.target.fileHash = h;
      app.target.fileName = file.name;
      $("dropSub").textContent = MS.fmtCompact(file.size) + "B · SHA-256 ready";
    } catch (e) {
      $("dropSub").textContent = "Could not hash this file";
      toast(e.message, "err");
    }
    updateTarget();
  }

  async function updateTarget() {
    const t = app.target;
    let hash = "", label = "";
    hashInput.classList.remove("bad");
    if (t.mode === "hash") {
      const v = hashInput.value.trim().toLowerCase();
      if (MS.isHash(v)) { hash = v; label = "SHA-256 hash"; }
      else if (v) hashInput.classList.add("bad");
    } else if (t.mode === "file") {
      if (t.fileHash) { hash = t.fileHash; label = "File · " + t.fileName; }
    } else if (testPw.value) {
      const r = await app.backend.makeTestTarget(testPw.value);
      hash = r.hash;
      label = "Test password (" + testPw.value.length + " chars)";
    }
    t.hash = hash;
    t.label = label;
    const p = $("hashPreview");
    p.textContent = hash || (t.mode === "hash" && hashInput.value ? "Needs exactly 64 hex characters" : "No target yet");
    p.classList.toggle("ok", !!hash);
    updateKeyspace();
  }

  function clusterEstimate() {
    if (!app.snap) return 0;
    return app.snap.nodes.reduce((s, n) => s + (n.status !== "offline" ? nodeEstimate(n) : 0), 0);
  }

  function updateKeyspace() {
    const L = +lenInput.value, cs = +chunkInput.value;
    const ks = MS.keyspaceSize(L);
    const chunks = Math.ceil(ks / cs);
    $("lenVal").textContent = L;
    $("ksL").textContent = L;
    $("ksSize").textContent = MS.fmtCompact(ks);
    $("ksSize").title = MS.fmtInt(ks) + " candidates";
    const ce = $("ksChunks");
    ce.textContent = MS.fmtInt(chunks);
    ce.style.color = chunks > MAX_CHUNKS ? "var(--coral)" : "";
    ce.title = chunks > MAX_CHUNKS ? "Too many chunks — choose a bigger chunk size" : "";
    const live = app.snap && app.snap.job.status === "running" ? app.snap.metrics.throughputMhs : 0;
    const mhs = live || clusterEstimate();
    $("ksEta").textContent = mhs > 0 ? MS.fmtDuration(ks / (mhs * 1e6) * 1000) : "—";
  }

  /* ================================================================ job buttons */
  $("startBtn").addEventListener("click", () =>
    act(async () => {
      const b = app.backend, j = app.snap.job;
      const cfg = { targetHash: app.target.hash, length: +lenInput.value, chunkSize: +chunkInput.value, targetLabel: app.target.label };
      const same = j && j.status !== "idle" && j.targetHash === cfg.targetHash && j.length === cfg.length && j.chunkSize === cfg.chunkSize;
      if (!same || ["found", "exhausted"].includes(j.status)) {
        if (!cfg.targetHash) throw new Error("Set a target first: paste a SHA-256, drop a file or type a test password.");
        if (Math.ceil(MS.keyspaceSize(cfg.length) / cfg.chunkSize) > MAX_CHUNKS) throw new Error("Too many chunks for this length — pick a bigger chunk size.");
        await b.createJob(cfg);
      }
      return b.start();
    })
  );
  $("pauseBtn").addEventListener("click", () => act(() => app.backend.stop()));
  $("resetBtn").addEventListener("click", () => act(() => app.backend.reset()));

  /* ================================================================ fault buttons */
  $("killBtn").addEventListener("click", () => {
    const id = $("killSel").value;
    if (id) act(() => app.backend.killNode(id));
  });
  $("killMasterBtn").addEventListener("click", () => act(() => app.backend.killMaster()));
  $("ntable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-kill],[data-revive]");
    if (!b) return;
    if (b.dataset.kill) act(() => app.backend.killNode(b.dataset.kill));
    else act(() => app.backend.reviveNode(b.dataset.revive));
  });

  /* ================================================================ result overlay */
  $("rClose").addEventListener("click", () => ($("result").hidden = true));
  $("rReset").addEventListener("click", () => {
    $("result").hidden = true;
    act(() => app.backend.reset());
  });

  function showResult(job) {
    const r = job.result;
    $("rIdx").textContent = MS.fmtInt(r.index);
    $("rNode").textContent = r.nodeName || r.nodeId;
    $("rTime").textContent = MS.fmtDuration(r.elapsedMs);
    $("rHashes").textContent = r.hashesComputed ? MS.fmtCompact(r.hashesComputed) : "—";
    $("rHash").textContent = "SHA-256(\"" + r.password + "\") = " + job.targetHash;
    $("result").hidden = false;
    // "decrypt" effect: letters lock in from left to right
    const el = $("rPw"), target = r.password;
    // time-based (not frame-based) so it ends on time even in a throttled tab
    const t0 = performance.now(), lockAt = (i) => 500 + i * 110;
    clearInterval(app.scrambleTimer);
    app.scrambleTimer = setInterval(() => {
      const dt = performance.now() - t0;
      let s = "";
      for (let i = 0; i < target.length; i++)
        s += dt > lockAt(i) ? target[i] : MS.CHARSET[Math.floor(Math.random() * 36)];
      el.textContent = s;
      if (dt > lockAt(target.length - 1)) { clearInterval(app.scrambleTimer); el.textContent = target; }
    }, 45);
  }

  /* ================================================================ settings */
  let pendingMode = "auto";
  $("connPill").addEventListener("click", () => {
    pendingMode = MS.settings.mode;
    syncModeSeg();
    $("urlInput").value = MS.settings.backendUrl;
    $("settings").hidden = false;
  });
  function syncModeSeg() {
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.m === pendingMode));
    $("urlInput").disabled = pendingMode === "demo";
  }
  document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => { pendingMode = b.dataset.m; syncModeSeg(); }));
  $("setCancel").addEventListener("click", () => ($("settings").hidden = true));
  $("settingsForm").addEventListener("submit", (e) => {
    e.preventDefault();
    MS.settings.mode = pendingMode;
    if ($("urlInput").value.trim()) MS.settings.backendUrl = $("urlInput").value.trim();
    $("settings").hidden = true;
    boot();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("settings").hidden = true; $("result").hidden = true; }
  });

  /* ================================================================ render: header + KPIs */
  const JOB_LABEL = { idle: "No job", ready: "Ready", running: "Running", paused: "Paused", found: "Recovered", exhausted: "Not found", halted: "Halted" };

  function renderHeader(s) {
    const pill = $("jobPill");
    pill.className = "pill " + s.job.status;
    pill.textContent = JOB_LABEL[s.job.status] || s.job.status;
    const st = s.job.status;
    $("startBtn").disabled = st === "running";
    $("startBtn").querySelector("span").textContent = st === "paused" || st === "halted" ? "Resume" : "Start";
    $("pauseBtn").disabled = st !== "running";
    $("resetBtn").disabled = st === "idle";
  }

  function renderKpis(s) {
    const m = s.metrics, j = s.job;
    const thr = m.throughputMhs || 0;
    if (thr >= 1000) { $("kThr").textContent = (thr / 1000).toFixed(2); $("kThrU").textContent = "GH/s"; }
    else { $("kThr").textContent = thr.toFixed(thr >= 100 ? 0 : 1); $("kThrU").textContent = "MH/s"; }
    $("kSpark").innerHTML = MS.sparkline(m.history && m.history.length ? m.history : [0, 0], 300, 86);
    $("kScan").textContent = (m.scannedPct || 0).toFixed(2) + "%";
    $("kScanBar").style.width = Math.min(100, m.scannedPct || 0) + "%";
    $("kScanAbs").textContent = j.keyspace ? `${MS.fmtCompact(j.scanned)} / ${MS.fmtCompact(j.keyspace)}` : "—";
    $("kDone").textContent = MS.fmtInt(m.completed || 0);
    $("kTotal").textContent = MS.fmtInt(j.totalChunks || 0);
    $("kPend").textContent = m.pending || 0;
    $("kFly").textContent = m.inFlight || 0;
    $("kRec").textContent = m.recovering || 0;
    const eff = m.efficiencyPct;
    const ke = $("kEff");
    ke.textContent = eff == null ? "—" : eff.toFixed(2) + "%";
    ke.className = "mid mono " + (eff == null ? "" : eff >= 90 ? "good" : "warn");
    $("kTime").textContent = MS.fmtClock(j.elapsedMs || 0);
    const remaining = j.keyspace ? j.keyspace - j.scanned : 0;
    $("kEta").textContent = j.status === "running" && thr > 0 ? "ETA " + MS.fmtDuration((remaining / (thr * 1e6)) * 1000) : j.status === "found" ? "Done" : "ETA —";
  }

  /* ================================================================ render: topology */
  const LAPTOP = '<path class="icon" d="M-11 -7h22v13h-22z M-15 8h30" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';

  function renderTopology(s) {
    const master = s.nodes.find((n) => n.role === "master");
    const others = s.nodes.filter((n) => n !== master);
    const running = s.job.status === "running";
    const key = JSON.stringify([s.nodes.map((n) => [n.id, n.role, n.status, n.name, n.mode]), running]);
    const host = $("topo");
    if (key !== app.topoKey) {
      app.topoKey = key;
      const W = 420, H = 336, cx = W / 2, cy = H / 2 - 4;
      const pos = {};
      if (master) pos[master.id] = [cx, cy];
      others.forEach((n, i) => {
        const k = others.length;
        const start = k === 1 ? 0 : k % 2 === 0 ? -Math.PI / 2 + Math.PI / k : -Math.PI / 2; // keep nodes off the vertical axis
        const a = start + (i / Math.max(1, k)) * Math.PI * 2;
        pos[n.id] = [cx + Math.cos(a) * 158, cy + Math.sin(a) * 118];
      });
      let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cluster topology">`;
      if (master)
        others.forEach((n) => {
          const [x, y] = pos[n.id];
          const cls = n.status === "offline" || master.status === "offline" ? "down" : running ? "flow" : "";
          svg += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="link ${cls}"/>`;
          if (n.role === "shadow" && n.status !== "offline") svg += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="link shadowsync" transform="translate(5 4)"/>`;
        });
      s.nodes.forEach((n) => {
        const [x, y] = pos[n.id];
        const isM = n === master;
        const r = isM ? 38 : 30;
        const c = isM ? "#5B5BF0" : color(n.id);
        const off = n.status === "offline";
        const roleC = n.role === "master" ? "#5B5BF0" : n.role === "shadow" ? "#C98100" : "#6A7593";
        svg += `<g class="tnode ${off ? "offline" : ""}" transform="translate(${x} ${y})" data-id="${n.id}">
          <circle r="${r}" class="hb" stroke="${off ? "#FF5A6E" : c}"/>
          <circle r="${r}" class="tnode-ring"/>
          <circle r="${r - 3}" class="halo" stroke="${off ? "#FF5A6E" : c}" ${n.status === "joining" ? 'stroke-dasharray="4 4"' : ""}/>
          <g style="color:${off ? "#FF5A6E" : c}" transform="scale(${isM ? 1.25 : 1})">${LAPTOP}</g>
          ${off ? `<path d="M${r - 14} ${-r + 2}l10 10m0-10-10 10" stroke="#FF5A6E" stroke-width="3" stroke-linecap="round"/>` : ""}
          ${isM ? `<text y="${-r - 8}" text-anchor="middle" class="crown">👑</text>` : ""}
          <text y="${r + 16}" text-anchor="middle">${MS.esc(n.name)}</text>
          <text y="${r + 29}" text-anchor="middle" class="role" fill="${off ? "#D43A50" : roleC}">${off ? "offline" : MS.roleLabel(n.role)}</text>
          ${!isM && !off ? `<text y="${r + 42}" text-anchor="middle" class="sub" data-mhs="${n.id}"></text>` : ""}
        </g>`;
      });
      host.innerHTML = svg + "</svg>";
    }
    // live bits: heartbeat rings + per-node speed
    s.nodes.forEach((n) => {
      const g = host.querySelector(`g.tnode[data-id="${n.id}"]`);
      if (!g) return;
      if (app.hbSeen[n.id] !== n.hbSeq && n.status !== "offline") {
        const hb = g.querySelector(".hb");
        hb.classList.remove("beat");
        void hb.getBBox();
        hb.classList.add("beat");
      }
      app.hbSeen[n.id] = n.hbSeq;
      const t = g.querySelector(`[data-mhs="${n.id}"]`);
      if (t) t.textContent = n.mhs > 0 ? MS.fmtMhs(n.mhs) : n.mode === "gpu" ? "GPU idle" : "CPU idle";
    });
    const online = s.nodes.filter((n) => n.status === "online").length;
    $("topoHint").textContent = `${online}/${s.nodes.length} online · heartbeat 500 ms · timeout 1 s`;
  }

  /* ================================================================ render: keyspace strip */
  function renderStrip(s) {
    const chunks = s.chunks || [];
    const strip = $("strip");
    const key = chunks.length + ":" + (s.job.targetHash || "") + ":" + (s.job.length || 0);
    if (key !== app.stripKey) {
      app.stripKey = key;
      strip.innerHTML = "";
      strip.style.setProperty("--cell", chunks.length <= 120 ? "22px" : chunks.length <= 300 ? "15px" : chunks.length <= 900 ? "11px" : "8px");
      app.stripCells = chunks.map((c) => {
        const d = document.createElement("div");
        d.className = "cell";
        d._k = "";
        strip.appendChild(d);
        return d;
      });
      if (!chunks.length) strip.innerHTML = '<p class="empty" style="grid-column:1/-1;color:var(--muted);margin:0;font-size:12.5px">Start a job to slice the keyspace into chunks.</p>';
      const L = s.job.length;
      $("stripHint").textContent = L ? `[0, 36^${L}) · ${MS.fmtInt(chunks.length)} chunks · 1 cell = 1 chunk` : "[0, 36^L)";
    }
    const hitChunk = s.job.result ? s.job.result.chunkId : -1;
    chunks.forEach((c, i) => {
      const d = app.stripCells[i];
      if (!d) return;
      const k = c.status + "|" + c.nodeId + "|" + (c.id === hitChunk);
      if (d._k === k) return;
      d._k = k;
      d.className = "cell";
      d.style.background = "";
      d.style.removeProperty("--c");
      const col = c.nodeId ? color(c.nodeId) : null;
      if (c.id === hitChunk) d.classList.add("hit");
      else if (c.status === ST.COMPLETED && col) d.style.background = hexA(col, 0.5);
      else if (c.status === ST.IN_FLIGHT && col) { d.style.background = col; d.style.setProperty("--c", col); d.classList.add("fly"); }
      else if (c.status === ST.RECOVERING) d.classList.add("rec");
      const owner = c.nodeId ? nodeById(c.nodeId) : null;
      d.title = `Chunk #${c.id} [${MS.fmtInt(c.start)}, ${MS.fmtInt(c.end)}) · ${["pending", "in-flight", "completed", "recovering"][c.status]}${owner ? " · " + owner.name : ""}`;
    });
    // legend
    let lg = s.nodes.filter((n) => n.role !== "master").map((n) => `<span><i style="background:${color(n.id)}"></i>${MS.esc(n.name)}</span>`).join("");
    lg += '<span><i style="background:#fff;border:1px solid rgba(27,36,64,.15)"></i>pending</span>';
    lg += '<span><i style="background:repeating-linear-gradient(45deg,#FFA62B 0 3px,#ffd08a 3px 6px)"></i>recovering</span>';
    lg += '<span><i style="background:linear-gradient(135deg,#00B8A9,#5B5BF0)"></i>match</span>';
    if ($("legend")._k !== lg) { $("legend").innerHTML = lg; $("legend")._k = lg; }
  }

  /* ================================================================ render: node table */
  const KILL = '<svg viewBox="0 0 24 24"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const REVIVE = '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function renderTable(s) {
    let h = `<div class="nrow head"><div>Laptop</div><div>Status</div><div>Compute</div><div>Chunk</div><div>Speed</div><div></div></div>`;
    s.nodes.forEach((n) => {
      const off = n.status === "offline";
      const isM = n.role === "master";
      const c = isM ? "#5B5BF0" : color(n.id);
      const prog = n.chunkId != null ? n.chunkProgress * 100 : 0;
      h += `<div class="nrow ${off ? "offline" : ""}">
        <div class="n-main"><span class="swatch" style="background:${c}"></span>
          <div style="min-width:0"><div class="n-name">${MS.esc(n.name)}</div>
          <div class="n-sub"><span class="badge ${n.role}">${MS.roleLabel(n.role)}</span><span class="mono">${MS.esc(n.host)}</span></div></div></div>
        <div><span class="status ${n.status}"><i></i>${n.status}</span>
          <div class="n-sub mono">${off ? "no heartbeat " + (n.heartbeatAgeMs / 1000).toFixed(1) + " s" : "♥ " + n.latencyMs.toFixed(0) + " ms"}</div></div>
        <div class="n-mode"><div>${n.server ? '<span class="badge master">master.py</span>' : `<span class="badge ${n.mode}">${n.mode === "gpu" ? "OpenCL GPU" : isLive() ? "CPU engine" : "OpenMP CPU"}</span>`}</div>
          <small>${MS.esc(deviceLabel(n))} · CPU ${n.cpuLoad.toFixed(0)}%</small></div>
        <div class="n-prog">${isM ? '<small><span>coordinating</span></small>' : `<small><span class="mono">${n.chunkId != null ? "#" + n.chunkId : "—"}</span><span class="mono">${n.chunkId != null ? prog.toFixed(0) + "%" : ""}</span></small><div class="bar"><i style="width:${prog}%;${off ? "background:var(--coral)" : ""}"></i></div>`}</div>
        <div class="n-num">${isM ? "—" : n.mhs > 0 ? MS.fmtMhs(n.mhs) : "0"}<small>${MS.fmtInt(n.chunksDone)} chunks</small></div>
        <div class="n-act">${off || !n.alive
          ? `<button class="icon-btn revive" data-revive="${n.id}" title="Restart ${MS.esc(n.name)}">${REVIVE}</button>`
          : `<button class="icon-btn" data-kill="${n.id}" title="Kill ${MS.esc(n.name)} (fault injection)">${KILL}</button>`}</div>
      </div>`;
    });
    $("ntable").innerHTML = h;
    const comp = s.nodes.filter((n) => n.role !== "master" && n.status === "online");
    $("nodesHint").textContent = `${comp.length} computing · ${s.nodes.filter((n) => n.mode === "gpu" && n.role !== "master").length} GPU / ${s.nodes.filter((n) => n.mode === "cpu" && n.role !== "master").length} CPU`;
  }

  /* ================================================================ render: fault panel + log */
  function renderFault(s) {
    const sel = $("killSel");
    const opts = s.nodes.filter((n) => n.role !== "master" && n.alive !== false && n.status !== "offline")
      .sort((a, b) => (a.role === "shadow") - (b.role === "shadow")); // plain workers first
    const optKey = opts.map((n) => n.id + n.name + n.role).join();
    if (sel._k !== optKey) {
      const keep = sel.value;
      sel.innerHTML = opts.map((n) => `<option value="${n.id}">${MS.esc(n.name)}${n.role === "shadow" ? " (Shadow)" : ""}</option>`).join("") || "<option value=''>No live workers</option>";
      if (opts.some((n) => n.id === keep)) sel.value = keep;
      sel._k = optKey;
    }
    $("killBtn").disabled = !opts.length;
    const m = s.nodes.find((n) => n.role === "master");
    $("killMasterBtn").disabled = !m || m.status === "offline" || m.alive === false;
    $("killMasterBtn").textContent = "Kill Master" + (m ? " (" + m.name + ")" : "");

    const items = (s.recoveries || []).map((r) => ({ t: r.t, kind: "rec", r }))
      .concat(s.events.filter((e) => e.kind === "failover").map((e) => ({ t: e.t, kind: "fo", e })))
      .sort((a, b) => b.t - a.t);
    const key = JSON.stringify(items.map((i) => [i.t, i.r && i.r.toNodeId]));
    if (key === app.recKey) return;
    app.recKey = key;
    if (!items.length) {
      $("recov").innerHTML = '<p class="empty">No recoveries yet. Kill a node mid-run to watch its chunk roll back to the last checkpoint and move to a healthy laptop.</p>';
      return;
    }
    const arrow = '<svg viewBox="0 0 24 24"><path d="M5 12h14m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    $("recov").innerHTML = items.map((it) => {
      if (it.kind === "fo")
        return `<div class="rec failover"><div class="rec-h">👑 Master failover<span>${MS.fmtClock(it.t)}</span></div><small style="font-family:var(--font)">${MS.esc(it.e.msg.replace(/^👑\s*/, ""))}</small></div>`;
      const r = it.r, from = nodeById(r.fromNodeId), to = r.toNodeId ? nodeById(r.toNodeId) : null;
      const span = r.end - r.start;
      const saved = ((r.checkpoint - r.start) / span) * 100;
      const lost = (r.lostHashes / span) * 100;
      return `<div class="rec"><div class="rec-h">Chunk #${r.chunkId}<span>${MS.fmtClock(r.t)}</span></div>
        <div class="rec-flow"><span class="from">${MS.esc(from ? from.name : r.fromNodeId)}</span>${arrow}${to ? `<span class="to">${MS.esc(to.name)}</span>` : '<span class="wait">waiting in queue…</span>'}</div>
        <div class="ckbar"><i class="saved" style="width:${saved}%"></i><i class="lost" style="left:${saved}%;width:${Math.max(0.6, lost)}%"></i></div>
        <small>checkpoint ${MS.fmtInt(r.checkpoint)} · ${saved.toFixed(0)}% kept · ${MS.fmtCompact(r.lostHashes)} redone</small></div>`;
    }).join("");
  }

  function renderLog(s) {
    const ev = s.events || [];
    const key = ev.length + ":" + (ev.length ? ev[ev.length - 1].t + ev[ev.length - 1].msg : "");
    if (key === app.logKey) return;
    app.logKey = key;
    $("log").innerHTML = ev.slice().reverse().map((e) => `<li class="${e.level}"><time>${MS.fmtClock(e.t)}</time><span>${MS.esc(e.msg)}</span></li>`).join("") ||
      '<li class="info"><time>—</time><span>Waiting for a job…</span></li>';
  }

  /* ================================================================ render: hypotheses */
  function renderHypotheses(s) {
    const compute = s.nodes.filter((n) => n.role !== "master" && n.status === "online");
    const gpu = compute.filter((n) => n.mode === "gpu");
    const cpuNodes = compute.filter((n) => n.mode === "cpu");
    const avgLoad = compute.length ? compute.reduce((a, n) => a + n.cpuLoad, 0) / compute.length : 0;
    const h1 = `${gpu.length} GPU + ${cpuNodes.length} CPU nodes · avg host CPU ${avgLoad.toFixed(0)}%` + (cpuNodes.some((n) => n.antiChoke) ? " · Anti-Choke on" : "");
    const recs = (s.recoveries || []).length;
    const fo = (s.events || []).filter((e) => e.kind === "failover").length;
    const h2 = recs || fo ? `${recs} chunk${recs === 1 ? "" : "s"} recovered · ${fo} failover${fo === 1 ? "" : "s"}` : "Waiting for a fault — try Kill worker";
    const eff = s.metrics.efficiencyPct;
    const h3 = eff == null ? "Pull-based queue · measured when running" : `Efficiency ${eff.toFixed(2)}% (target > 90%)`;
    const set = (id, txt, ok) => { const el = $(id); el.querySelector("small").textContent = txt; el.className = "hyp " + (ok === true ? "ok" : ok === false ? "bad" : ""); };
    set("hyp1", h1, gpu.length ? true : null);
    set("hyp2", h2, s.job.status === "halted" ? false : recs || fo ? true : null);
    set("hyp3", h3, eff == null ? null : eff >= 90);
  }

  /* ================================================================ render: node cards (Nodes view) */
  function renderCards() {
    const s = app.snap;
    if (!s || !$("view-nodes").classList.contains("active")) return;
    const key = JSON.stringify(s.nodes.map((n) => [n.id, n.name, n.host, n.role, n.mode, n.device, n.cpuThreads, n.antiChoke, n.status, s.job.status === "running"]));
    if (key === app.cardsKey) return;
    if (document.activeElement && $("ncards").contains(document.activeElement) && document.activeElement.tagName === "INPUT") return;
    app.cardsKey = key;
    const running = s.job.status === "running";
    const devOpts = (cur) => Object.entries(MS.DEVICES).map(([k, d]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${d.label}${d.measured ? " · measured" : ""}</option>`).join("");
    let h = s.nodes.map((n) => {
      const c = n.role === "master" ? "#5B5BF0" : color(n.id);
      const est = nodeEstimate(n);
      const load = n.role === "master" ? 4 : n.mode === "gpu" ? 2 : (n.threadsAllowed / n.cpuThreads) * 100;
      return `<article class="card glass ncard" style="--c:${c}" data-id="${n.id}">
        <div class="ncard-h"><input data-f="name" value="${MS.esc(n.name)}" aria-label="Name">
          <span class="status ${n.status}"><i></i>${n.status}</span></div>
        <div class="two">
          <label class="fld"><span>IP address</span><input data-f="host" class="mono" value="${MS.esc(n.host)}"></label>
          <label class="fld"><span>Role</span><select data-f="role" ${running || (isLive() && n.role === "master") ? "disabled" : ""}>
            ${["master", "shadow", "worker"].map((r) => `<option value="${r}" ${r === n.role ? "selected" : ""} ${isLive() && r === "master" && n.role !== "master" ? "disabled" : ""}>${MS.roleLabel(r)}</option>`).join("")}</select></label>
        </div>
        ${n.server ? `<div class="toggle"><div><b>Coordinator</b><small>This laptop runs master.py: queue, heartbeats, recovery. Run worker.py here too if it should also hash.</small></div></div>` : `
        <div class="seg" data-f="mode">
          <button type="button" data-v="gpu" class="${n.mode === "gpu" ? "active" : ""}" ${n.gpuAvailable === false ? 'disabled title="No OpenCL GPU found on this laptop"' : ""}>GPU · OpenCL</button>
          <button type="button" data-v="cpu" class="${n.mode === "cpu" ? "active" : ""}">CPU · ${isLive() ? "C engine" : "OpenMP SIMD"}</button>
        </div>
        ${n.mode === "gpu"
          ? isLive()
            ? `<div class="fld"><span>GPU device (detected)</span><b class="mono" style="padding:9px 0">${MS.esc(n.deviceLabel || "GPU")}</b></div>`
            : `<label class="fld"><span>GPU device</span><select data-f="device">${devOpts(n.device)}</select></label>`
          : `<div class="two">
              <label class="fld"><span>Logical CPU threads</span><input type="number" min="1" max="64" data-f="cpuThreads" value="${n.cpuThreads}"></label>
              <div class="fld"><span>Allowed</span><b class="mono" style="padding:9px 0;font-size:15px">${n.threadsAllowed} threads</b></div>
            </div>
            <label class="toggle"><div><b>Anti-Choke guard</b><small>Keep 2 threads free for OS + MPI heartbeats</small></div>
              <span class="switch"><input type="checkbox" data-f="antiChoke" ${n.antiChoke ? "checked" : ""}><i></i></span></label>`}`}
        <div class="estimate"><small>${n.role === "master" ? "Orchestrates the queue (no hashing)" : (isLive() ? "Measured" : "Expected") + " throughput · CPU load " + load.toFixed(0) + "%"}</small><b>${n.role === "master" ? "—" : est ? MS.fmtMhs(est) : "—"}</b></div>
        <div class="row">
          ${n.status === "offline" || !n.alive ? `<button class="btn sm" data-act="revive" style="flex:1">Restart</button>` : `<button class="btn sm danger ghost" data-act="kill" style="flex:1">Kill (fault test)</button>`}
          <button class="btn sm ghost" data-act="remove" ${running || n.role === "master" ? "disabled" : ""} title="${n.role === "master" ? "Make another node Master first" : "Remove"}">Remove</button>
        </div>
      </article>`;
    }).join("");
    const master = s.nodes.find((n) => n.server) || s.nodes.find((n) => n.role === "master");
    if (s.nodes.length < 5)
      h += isLive()
        ? `<article class="card glass add-card join-card"><div><span>+</span><b>Add a laptop (${s.nodes.length}/5)</b>
            <p>On that laptop, inside the project folder, run:</p>
            <code class="mono">python3 cluster/worker.py --master ${MS.esc(master ? master.host : location.hostname)}:${location.port || 8000}</code>
            <p>It appears here by itself within a second.</p></div></article>`
        : `<button class="card add-card" id="addCard"><div><span>+</span>Add laptop (${s.nodes.length}/5)</div></button>`;
    $("ncards").innerHTML = h;
    $("addNodeBtn").disabled = s.nodes.length >= 5;
    $("addNodeBtn").hidden = isLive();
  }

  function addNode() {
    const s = app.snap;
    const used = new Set(s.nodes.map((n) => n.name));
    let i = s.nodes.length + 1;
    while (used.has("laptop-" + i)) i++;
    act(() => app.backend.addNode({ name: "laptop-" + i, host: "192.168.1." + (9 + i), role: "worker", mode: "gpu", device: "intel-iris-xe", cpuThreads: 8, antiChoke: true }));
    app.cardsKey = "";
  }
  $("addNodeBtn").addEventListener("click", addNode);

  $("ncards").addEventListener("click", (e) => {
    if (e.target.closest("#addCard")) return addNode();
    const card = e.target.closest(".ncard");
    if (!card) return;
    const id = card.dataset.id;
    const segBtn = e.target.closest('.seg[data-f="mode"] button');
    if (segBtn) { app.cardsKey = ""; return act(() => app.backend.updateNode(id, { mode: segBtn.dataset.v })); }
    const a = e.target.closest("[data-act]");
    if (!a) return;
    app.cardsKey = "";
    if (a.dataset.act === "kill") act(() => app.backend.killNode(id));
    if (a.dataset.act === "revive") act(() => app.backend.reviveNode(id));
    if (a.dataset.act === "remove") act(() => app.backend.removeNode(id));
  });
  $("ncards").addEventListener("change", (e) => {
    const f = e.target.dataset.f;
    const card = e.target.closest(".ncard");
    if (!f || !card) return;
    let v = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    if (f === "cpuThreads") v = +v;
    if ((f === "name" || f === "host") && !String(v).trim()) return;
    app.cardsKey = "";
    act(() => app.backend.updateNode(card.dataset.id, { [f]: v }));
  });

  /* ================================================================ render: benchmarks */
  let benchDone = false;
  async function renderBench() {
    if (benchDone || !app.backend) return;
    const B = await app.backend.getBenchmarks();
    benchDone = true;
    $("benchMachine").textContent = "W10 baseline measured on " + B.machine + ". Source: src_w10/results_w10_scaling.csv and PROGRESS_REPORT_W10.md.";
    const gpu = B.backends.find((b) => /GPU/.test(b.label));
    if (gpu) $("hlGpu").textContent = gpu.speedup.toFixed(1) + "×";
    $("hlWeak").textContent = B.weak[B.weak.length - 1].eff.toFixed(2) + "%";
    $("hlLb").textContent = B.heterogeneousLoadBalancePct.toFixed(2) + "%";
    $("chartBackends").innerHTML = MS.barChartLog(B.backends);
    const xs = B.strong.map((r) => r.n);
    $("chartStrong").innerHTML = MS.lineChart({
      xs, yMax: 8.5, yTicks: [0, 2, 4, 6, 8], yFmt: (v) => v + "×", xFmt: (v) => v + "T", xLabel: "OpenMP threads",
      aria: "Strong scaling speedup vs ideal",
      series: [
        { values: xs, cls: "ideal", noDots: true },
        { values: B.strong.map((r) => r.speedup), cls: "teal", labels: B.strong.map((r) => r.speedup.toFixed(2) + "×") },
      ],
    });
    const wx = B.weak.map((r) => r.n);
    $("chartWeak").innerHTML = MS.lineChart({
      xs: wx, yMin: 80, yMax: 102, yTicks: [80, 85, 90, 95, 100], yFmt: (v) => v + "%", xFmt: (v) => v + (v === 1 ? " node" : " nodes"), xLabel: "Worker nodes",
      aria: "Weak scaling efficiency", ref: { y: 90, label: "H3 target 90%" },
      series: [{ values: B.weak.map((r) => r.eff), cls: "indigo", labels: B.weak.map((r) => r.eff.toFixed(1) + "%") }],
    });
    let t = "<table><thead><tr><th>Experiment</th><th>Threads / nodes</th><th>Hashes</th><th>Time (s)</th><th>MH/s</th><th>Speedup</th><th>Efficiency</th></tr></thead><tbody>";
    B.strong.forEach((r) => (t += `<tr class="${r.n === 6 ? "hi" : ""}"><td>Strong · CPU${r.n === 6 ? " (Anti-Choke)" : ""}</td><td>${r.n}</td><td>2,000,000</td><td>${r.time.toFixed(4)}</td><td>${r.mhs.toFixed(2)}</td><td>${r.speedup.toFixed(2)}×</td><td>${r.eff.toFixed(2)}%</td></tr>`));
    B.weak.forEach((r) => (t += `<tr><td>Weak · cluster</td><td>${r.n}</td><td>${MS.fmtInt(r.hashes)}</td><td>${r.time.toFixed(4)}</td><td>${r.mhs.toFixed(2)}</td><td>${r.n.toFixed(2)}×</td><td>${r.eff.toFixed(2)}%</td></tr>`));
    if (gpu) t += `<tr class="hi"><td>OpenCL GPU</td><td>80 CU</td><td>10,000,000</td><td>—</td><td>${gpu.mhs.toFixed(2)}</td><td>${gpu.speedup.toFixed(2)}×</td><td>—</td></tr>`;
    $("benchTable").innerHTML = t + "</tbody></table>";
  }

  /* ================================================================ main loop */
  function render() {
    const s = app.snap;
    if (!s) return;
    renderHeader(s);
    renderKpis(s);
    renderTopology(s);
    renderStrip(s);
    renderTable(s);
    renderFault(s);
    renderLog(s);
    renderHypotheses(s);
    renderCards();
    if (!$("lenInput").matches(":active")) updateKeyspace();
    if (s.job.status === "found" && s.job.result) {
      const k = s.job.targetHash + s.job.result.index + s.job.result.elapsedMs;
      if (app.resultShown !== k) { app.resultShown = k; showResult(s.job); }
    }
  }

  let failCount = 0;
  async function refresh() {
    if (!app.backend) return;
    try {
      app.snap = await app.backend.getState();
      failCount = 0;
      setConn();
      render();
    } catch (e) {
      failCount++;
      if (failCount === 3) toast(e.message, "err");
      setConn(e);
    }
  }

  function setConn(err) {
    const p = $("connPill");
    const b = app.backend;
    if (err) { p.className = "pill conn err"; p.querySelector("span").textContent = "Master unreachable"; return; }
    p.className = "pill conn " + b.mode;
    p.querySelector("span").textContent = b.mode === "live" ? "Live · " + b.base.replace(/^https?:\/\//, "") : "Demo simulator";
  }

  async function boot() {
    clearInterval(app.pollTimer);
    if (app.backend) app.backend.disconnect();
    Object.assign(app, { colorOf: {}, hbSeen: {}, stripKey: "", topoKey: "", cardsKey: "", recKey: "", logKey: "", resultShown: "" });
    benchDone = false;
    try {
      app.backend = await MS.createBackend();
    } catch (e) {
      toast(e.message + " — using the demo simulator.", "err");
      app.backend = e.fallback;
    }
    await app.backend.connect();
    if (app.backend.mode === "demo" && !testPw.value && !hashInput.value) {
      // friendly default so the first click on Start works out of the box
      document.querySelector('#targetSeg [data-t="test"]').click();
      $("randPw").click();
    }
    await refresh();
    await updateTarget();
    app.pollTimer = setInterval(refresh, app.backend.mode === "demo" ? 200 : 500);
    if ($("view-bench").classList.contains("active")) renderBench();
  }

  if (!MS.sha256SelfTest()) toast("SHA-256 self-test failed in this browser!", "err");
  boot();
})();
