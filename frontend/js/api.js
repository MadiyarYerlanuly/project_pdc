/* Mini-Spark — backend adapter + shared constants.
 *
 * The UI talks to ONE interface. Two implementations:
 *   MS.LiveBackend  → the real Master backend over HTTP (see API contract below / README)
 *   MS.DemoBackend  → in-browser simulator (simulator.js) for rehearsal without a cluster
 *
 * ---------------------------------------------------------------------------
 * API CONTRACT (all JSON, served by the Master laptop, e.g. http://192.168.x.x:8000)
 *   GET    /api/health                    → { ok: true }
 *   GET    /api/state                     → State snapshot (shape below), polled every 500 ms
 *   POST   /api/job                       { targetHash, length, chunkSize, targetLabel }
 *   POST   /api/job/target-file           multipart field "file" → { hash }
 *   POST   /api/job/start | /stop | /reset
 *   POST   /api/nodes                     { name, host, role, mode, device, cpuThreads, antiChoke }
 *   PATCH  /api/nodes/:id                 any subset of the fields above
 *   DELETE /api/nodes/:id
 *   POST   /api/fault/kill-node           { nodeId }
 *   POST   /api/fault/kill-master
 *   POST   /api/fault/revive              { nodeId }
 *   GET    /api/benchmarks                (optional) → same shape as MS.BENCHMARKS
 * Errors: non-2xx with { error: "human readable message" }.
 *
 * State snapshot:
 * {
 *   job: { status: idle|ready|running|paused|found|exhausted|halted, targetHash, targetLabel,
 *          length, chunkSize, keyspace, totalChunks, elapsedMs, scanned,
 *          result: null | { password, index, nodeId, nodeName, chunkId, elapsedMs, hashesComputed } },
 *   activeMasterId,
 *   nodes:  [{ id, name, host, role: master|shadow|worker, mode: gpu|cpu, device, cpuThreads,
 *              antiChoke, threadsAllowed, status: online|joining|offline, latencyMs,
 *              heartbeatAgeMs, hbSeq, chunkId, chunkProgress (0..1), checkpoint, mhs, cpuLoad,
 *              chunksDone, hashesDone }],
 *   chunks: [{ id, start, end, checkpoint, cursor, nodeId, status }]   // status = ChunkStatus
 *   metrics:{ throughputMhs, history: [MH/s every 500 ms], scannedPct,
 *             pending, inFlight, completed, recovering, efficiencyPct },
 *   recoveries: [{ t, chunkId, fromNodeId, toNodeId, checkpoint, start, end, lostHashes, savedPct }],
 *   events: [{ t, level: info|ok|warn|error, kind, msg }]
 * }
 * ------------------------------------------------------------------------- */
window.MS = window.MS || {};

(function () {
  /* Same codes as ChunkStatus in src_w6_w7/include/framework_types.h */
  MS.ChunkStatus = { PENDING: 0, IN_FLIGHT: 1, COMPLETED: 2, RECOVERING: 3 };

  MS.roleLabel = (r) => ({ master: "Master", shadow: "Shadow Master", worker: "Worker" }[r] || r);

  /* GPU catalog. Iris Xe is measured (W10 report); others are rough estimates
   * used only by the demo simulator — replace with real numbers in W12. */
  MS.DEVICES = {
    "intel-iris-xe": { label: "Intel Iris Xe (80 CU)", mhs: 197.48, measured: true },
    "apple-m2": { label: "Apple M2 GPU", mhs: 320, measured: false },
    "amd-radeon-680m": { label: "AMD Radeon 680M", mhs: 410, measured: false },
    "nvidia-rtx-3050": { label: "NVIDIA RTX 3050 Laptop", mhs: 880, measured: false },
  };

  /* src_w10/results_w10_scaling.csv + GPU row from PROGRESS_REPORT_W10.md */
  MS.BENCHMARKS = {
    machine: "Intel Core i5-1135G7 + Intel Iris Xe (80 CU)",
    backends: [
      { label: "Serial", detail: "1 thread", mhs: 2.38, speedup: 1.0, cpuLoad: 12.5 },
      { label: "OpenMP", detail: "2 threads", mhs: 4.56, speedup: 1.91, cpuLoad: 25 },
      { label: "OpenMP", detail: "4 threads", mhs: 7.69, speedup: 3.22, cpuLoad: 50 },
      { label: "Anti-Choke", detail: "6 threads", mhs: 9.38, speedup: 3.94, cpuLoad: 75 },
      { label: "OpenMP", detail: "8 threads", mhs: 10.62, speedup: 4.46, cpuLoad: 100 },
      { label: "OpenCL GPU", detail: "80 CU", mhs: 197.48, speedup: 85.1, cpuLoad: 2 },
    ],
    strong: [
      { n: 1, time: 0.8389, mhs: 2.38, speedup: 1.0, eff: 100.0 },
      { n: 2, time: 0.439, mhs: 4.56, speedup: 1.91, eff: 95.54 },
      { n: 4, time: 0.2602, mhs: 7.69, speedup: 3.22, eff: 80.6 },
      { n: 6, time: 0.2131, mhs: 9.38, speedup: 3.94, eff: 65.61 },
      { n: 8, time: 0.1883, mhs: 10.62, speedup: 4.46, eff: 55.69 },
    ],
    weak: [
      { n: 1, hashes: 1e6, time: 0.0861, mhs: 11.61, eff: 100.0 },
      { n: 2, hashes: 2e6, time: 0.0877, mhs: 22.82, eff: 98.23 },
      { n: 3, hashes: 3e6, time: 0.0892, mhs: 33.63, eff: 96.53 },
      { n: 4, hashes: 4e6, time: 0.0908, mhs: 44.07, eff: 94.88 },
    ],
    heterogeneousLoadBalancePct: 96.06,
  };

  class LiveBackend {
    constructor(baseUrl) {
      this.mode = "live";
      this.base = (baseUrl || "").replace(/\/+$/, "");
    }

    async _req(method, path, body, isForm) {
      const opts = { method, headers: {} };
      if (body !== undefined) {
        if (isForm) opts.body = body;
        else { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
      }
      let res;
      try {
        res = await fetch(this.base + path, opts);
      } catch (e) {
        throw new Error("Master backend unreachable at " + (this.base || location.origin));
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
      if (!res.ok) throw new Error((data && data.error) || `${method} ${path} failed (${res.status})`);
      return data;
    }

    async connect() {
      const h = await this._req("GET", "/api/health");
      return { ok: !!(h && h.ok !== false), mode: "live" };
    }
    disconnect() {}

    getState() { return this._req("GET", "/api/state"); }

    async hashFile(file) {
      const fd = new FormData();
      fd.append("file", file);
      try {
        const r = await this._req("POST", "/api/job/target-file", fd, true);
        return r.hash;
      } catch (e) {
        return MS.sha256File(file); // backend lacks the endpoint → hash locally
      }
    }

    async makeTestTarget(password) {
      return { hash: MS.sha256Hex(password), password };
    }

    createJob(cfg) { return this._req("POST", "/api/job", cfg); }
    start() { return this._req("POST", "/api/job/start", {}); }
    stop() { return this._req("POST", "/api/job/stop", {}); }
    reset() { return this._req("POST", "/api/job/reset", {}); }

    addNode(cfg) { return this._req("POST", "/api/nodes", cfg); }
    updateNode(id, patch) { return this._req("PATCH", "/api/nodes/" + encodeURIComponent(id), patch); }
    removeNode(id) { return this._req("DELETE", "/api/nodes/" + encodeURIComponent(id)); }

    killNode(id) { return this._req("POST", "/api/fault/kill-node", { nodeId: id }); }
    killMaster() { return this._req("POST", "/api/fault/kill-master", {}); }
    reviveNode(id) { return this._req("POST", "/api/fault/revive", { nodeId: id }); }

    async getBenchmarks() {
      try { return (await this._req("GET", "/api/benchmarks")) || MS.BENCHMARKS; }
      catch (_) { return MS.BENCHMARKS; }
    }
  }
  MS.LiveBackend = LiveBackend;

  /* ---- settings + auto-detection ---- */
  function storeGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function storeSet(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }

  MS.settings = {
    get mode() { return new URLSearchParams(location.search).get("mode") || storeGet("ms.mode") || "auto"; },
    set mode(v) { storeSet("ms.mode", v); },
    get backendUrl() {
      const saved = storeGet("ms.backendUrl");
      if (saved) return saved;
      return location.protocol.startsWith("http") ? location.origin : "http://localhost:8000";
    },
    set backendUrl(v) { storeSet("ms.backendUrl", v); },
  };

  /* auto: try the live Master for 1.5 s, otherwise fall back to the demo simulator */
  MS.createBackend = async function () {
    const mode = MS.settings.mode;
    if (mode !== "demo") {
      const live = new LiveBackend(MS.settings.backendUrl);
      try {
        await Promise.race([
          live.connect(),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 1500)),
        ]);
        return live;
      } catch (e) {
        if (mode === "live") {
          const err = new Error("Live backend not reachable: " + e.message);
          err.fallback = new MS.DemoBackend();
          throw err;
        }
      }
    }
    return new MS.DemoBackend();
  };
})();
