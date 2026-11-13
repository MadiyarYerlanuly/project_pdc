/* Mini-Spark — in-browser DEMO backend.
 * Implements exactly the same interface as MS.LiveBackend (see api.js), so the
 * UI can be built and rehearsed before the real Master backend exists.
 *
 * It models the engine described in PROJECT_WIKI.md:
 *  - Base-36 keyspace [0, 36^L) sliced into TaskChunks (pull-based queue, H3)
 *  - 500 ms heartbeats with checkpoint_index, 1000 ms timeout (H2)
 *  - chunk rollback to last checkpoint + priority re-queue (CHUNK_RECOVERING)
 *  - Shadow Master promotion when the primary Master dies (H2)
 *  - GPU (OpenCL) vs CPU (OpenMP + SIMD, Anti-Choke = total threads − 2) (H1)
 * Throughputs come from src_w10 measurements where we have them; other GPUs are
 * marked as estimates in DEVICES below. */
window.MS = window.MS || {};

(function () {
  const ST = MS.ChunkStatus; // defined in api.js
  const HEARTBEAT_MS = 500;
  const TIMEOUT_MS = 1000;
  const TICK_MS = 50;

  /* Measured CPU OpenMP+SIMD throughput, i5-1135G7 (results_w10_scaling.csv) */
  const CPU_CURVE = { 1: 2.38, 2: 4.56, 4: 7.69, 6: 9.38, 8: 10.62 };
  function cpuMhs(threads) {
    const keys = Object.keys(CPU_CURVE).map(Number).sort((a, b) => a - b);
    if (threads <= keys[0]) return CPU_CURVE[keys[0]] * threads;
    for (let i = 1; i < keys.length; i++) {
      if (threads <= keys[i]) {
        const a = keys[i - 1], b = keys[i];
        return CPU_CURVE[a] + ((CPU_CURVE[b] - CPU_CURVE[a]) * (threads - a)) / (b - a);
      }
    }
    const last = keys[keys.length - 1];
    return CPU_CURVE[last] + (threads - last) * 0.6; // diminishing (SMT contention)
  }

  const DEVICES = MS.DEVICES; // defined in api.js

  function rand(a, b) { return a + Math.random() * (b - a); }

  function nodeBaseMhs(n) {
    if (n.mode === "gpu") return (DEVICES[n.device] || { mhs: 150 }).mhs;
    return cpuMhs(n.threadsAllowed);
  }

  class DemoBackend {
    constructor() {
      this.mode = "demo";
      this.known = new Map(); // demo targets: hash -> password
      this.nextNodeId = 0;
      this.nodes = [];
      [
        { name: "laptop-1", host: "192.168.1.10", role: "master", mode: "gpu", device: "intel-iris-xe", cpuThreads: 8 },
        { name: "laptop-2", host: "192.168.1.11", role: "shadow", mode: "gpu", device: "apple-m2", cpuThreads: 8 },
        { name: "laptop-3", host: "192.168.1.12", role: "worker", mode: "gpu", device: "intel-iris-xe", cpuThreads: 8 },
        { name: "laptop-4", host: "192.168.1.13", role: "worker", mode: "gpu", device: "nvidia-rtx-3050", cpuThreads: 12 },
        { name: "laptop-5", host: "192.168.1.14", role: "worker", mode: "cpu", device: "intel-iris-xe", cpuThreads: 8 },
      ].forEach((n) => this._addNodeRaw(n));
      this._resetJob(null);
      this.timer = null;
      this.lastTick = performance.now();
    }

    /* ------------------------------------------------------------ setup */
    connect() {
      if (!this.timer) {
        this.lastTick = performance.now();
        this.timer = setInterval(() => this._tick(), TICK_MS);
      }
      return Promise.resolve({ ok: true, mode: "demo" });
    }

    disconnect() {
      clearInterval(this.timer);
      this.timer = null;
    }

    _addNodeRaw(cfg) {
      const n = {
        id: "n" + this.nextNodeId++,
        name: cfg.name,
        host: cfg.host,
        role: cfg.role || "worker",
        mode: cfg.mode || "gpu",
        device: cfg.device || "intel-iris-xe",
        cpuThreads: cfg.cpuThreads || 8,
        antiChoke: cfg.antiChoke !== false,
        threadsAllowed: 0,
        // runtime
        alive: true,
        status: "online",
        latencyMs: rand(2, 9),
        lastHb: performance.now() - rand(0, HEARTBEAT_MS),
        hbSeq: 0,
        chunkId: null,
        mhs: 0,
        busyMs: 0,
        idleMs: 0,
        idleUntil: 0,
        chunksDone: 0,
        hashesDone: 0,
        hbHashes: 0,
      };
      n.threadsAllowed = n.antiChoke ? Math.max(1, n.cpuThreads - 2) : n.cpuThreads;
      this.nodes.push(n);
      return n;
    }

    _resetJob(job) {
      this.job = job;
      this.chunks = [];
      this.events = [];
      this.recoveries = [];
      this.history = [];
      this.elapsedMs = 0;
      this.result = null;
      this.status = job ? "ready" : "idle";
      this.lastSample = 0;
      for (const n of this.nodes) {
        n.chunkId = null; n.busyMs = 0; n.idleMs = 0; n.chunksDone = 0; n.hashesDone = 0; n.mhs = 0; n.hbHashes = 0;
      }
      if (job) {
        const total = MS.keyspaceSize(job.length);
        for (let s = 0, id = 0; s < total; s += job.chunkSize, id++) {
          const e = Math.min(total, s + job.chunkSize);
          this.chunks.push({ id, start: s, end: e, checkpoint: s, cursor: s, nodeId: null, status: ST.PENDING });
        }
      }
    }

    _log(level, msg, kind) {
      this.events.push({ t: this.elapsedMs, level, kind: kind || "info", msg });
      if (this.events.length > 300) this.events.shift();
    }

    _node(id) { return this.nodes.find((n) => n.id === id); }
    _master() { return this.nodes.find((n) => n.role === "master"); }
    _shadow() { return this.nodes.find((n) => n.role === "shadow"); }
    _computes(n) { return n.role !== "master"; } // rank 0 orchestrates only

    /* ------------------------------------------------------------ job API */
    async hashFile(file) {
      return MS.sha256File(file);
    }

    async makeTestTarget(password) {
      const hash = MS.sha256Hex(password);
      this.known.set(hash, password);
      return { hash, password };
    }

    async createJob({ targetHash, length, chunkSize, targetLabel }) {
      if (this.status === "running") throw new Error("Stop the running job first.");
      const total = MS.keyspaceSize(length);
      this._resetJob({ targetHash, length, chunkSize, targetLabel: targetLabel || "SHA-256 hash", keyspace: total });
      const pw = this.known.get(targetHash);
      this.job.targetIndex = pw && pw.length === length ? MS.passwordToIndex(pw) : -1;
      this._log("info", `Job created · L=${length} · keyspace ${MS.fmtCompact(total)} · ${this.chunks.length} chunks × ${MS.fmtCompact(chunkSize)}`, "job");
      if (this.job.targetIndex < 0)
        this._log("warn", "Demo mode: this hash was not generated here, so the simulator will scan the whole keyspace without a match.", "job");
      return this.getState();
    }

    async start() {
      if (!this.job) throw new Error("Create a job first.");
      if (["found", "exhausted"].includes(this.status)) throw new Error("Job finished — reset to run again.");
      if (this.status === "running") return this.getState();
      const m = this._master();
      if (!m || m.status !== "online") throw new Error("No online Master — revive a node or promote one.");
      this.status = "running";
      this._log("ok", this.elapsedMs ? "Computation resumed" : `Computation started on ${this.nodes.filter((n) => this._computes(n) && n.status === "online").length} compute nodes`, "job");
      return this.getState();
    }

    async stop() {
      if (this.status === "running") {
        this.status = "paused";
        this._log("info", "Computation paused — in-flight chunks keep their checkpoints", "job");
      }
      return this.getState();
    }

    async reset() {
      const job = this.job;
      if (!job) return this.getState();
      this._resetJob({ ...job });
      this.job.targetIndex = job.targetIndex;
      this._log("info", "Job reset — chunk queue regenerated", "job");
      return this.getState();
    }

    /* ------------------------------------------------------------ nodes API */
    async addNode(cfg) {
      if (this.nodes.length >= 5) throw new Error("The cluster supports up to 5 laptops.");
      const n = this._addNodeRaw({ role: "worker", ...cfg });
      n.status = "joining";
      n.lastHb = performance.now() - HEARTBEAT_MS;
      this._log("info", `${n.name} (${n.host}) registered · ${this._modeLabel(n)}`, "node");
      return this.getState();
    }

    async updateNode(id, patch) {
      const n = this._node(id);
      if (!n) throw new Error("Unknown node");
      const running = this.status === "running";
      if (patch.role && patch.role !== n.role) {
        if (running) throw new Error("Change roles while the job is stopped.");
        if (patch.role === "master") {
          const old = this._master();
          if (old) old.role = n.role === "shadow" ? "shadow" : "worker";
          this._releaseChunk(n);
        }
        if (patch.role === "shadow") {
          const old = this._shadow();
          if (old) old.role = "worker";
        }
        if (n.role === "master" && patch.role !== "master") throw new Error("Make another node the Master instead.");
        n.role = patch.role;
        this._log("info", `${n.name} is now ${MS.roleLabel(n.role)}`, "node");
      }
      if (patch.name) n.name = patch.name;
      if (patch.host) n.host = patch.host;
      if (patch.mode) n.mode = patch.mode;
      if (patch.device) n.device = patch.device;
      if (patch.cpuThreads) n.cpuThreads = Math.max(1, Math.min(64, patch.cpuThreads | 0));
      if (typeof patch.antiChoke === "boolean") n.antiChoke = patch.antiChoke;
      n.threadsAllowed = n.antiChoke ? Math.max(1, n.cpuThreads - 2) : n.cpuThreads;
      if (patch.mode || patch.device || patch.cpuThreads || typeof patch.antiChoke === "boolean")
        this._log("info", `${n.name} → ${this._modeLabel(n)}`, "node");
      return this.getState();
    }

    async removeNode(id) {
      const n = this._node(id);
      if (!n) return this.getState();
      if (this.status === "running") throw new Error("Stop the job before removing a laptop.");
      if (n.role === "master") throw new Error("Assign another Master before removing this one.");
      this._releaseChunk(n);
      this.nodes = this.nodes.filter((x) => x !== n);
      this._log("info", `${n.name} removed from the cluster`, "node");
      return this.getState();
    }

    _modeLabel(n) {
      return n.mode === "gpu"
        ? `OpenCL GPU · ${(DEVICES[n.device] || {}).label || n.device}`
        : `OpenMP SIMD CPU · ${n.threadsAllowed}/${n.cpuThreads} threads${n.antiChoke ? " (Anti-Choke)" : ""}`;
    }

    _releaseChunk(n) {
      if (n.chunkId == null) return;
      const c = this.chunks[n.chunkId];
      if (c && c.status === ST.IN_FLIGHT) { c.status = ST.PENDING; c.nodeId = null; }
      n.chunkId = null;
    }

    /* ------------------------------------------------------------ fault API */
    async killNode(id) {
      const n = this._node(id);
      if (!n || !n.alive) return this.getState();
      n.alive = false;
      this._log("error", `💥 Fault injected: ${n.name} (${MS.roleLabel(n.role)}) process killed`, "fault");
      return this.getState();
    }

    async killMaster() {
      const m = this._master();
      if (m) return this.killNode(m.id);
      return this.getState();
    }

    async reviveNode(id) {
      const n = this._node(id);
      if (!n || n.alive) return this.getState();
      n.alive = true;
      n.status = "joining";
      n.lastHb = performance.now() - HEARTBEAT_MS;
      if (n.role === "master" && this._master() !== n) n.role = "worker";
      if (n.role === "worker" && !this._shadow()) {
        n.role = "shadow";
        this._log("info", `${n.name} restarted — rejoins as the new Shadow Master (standby)`, "node");
      } else this._log("info", `${n.name} restarted — re-registering with the Master`, "node");
      return this.getState();
    }

    /* ------------------------------------------------------------ simulation */
    _tick() {
      const now = performance.now();
      const dt = Math.min(250, now - this.lastTick);
      this.lastTick = now;
      const running = this.status === "running";
      if (running) this.elapsedMs += dt;

      const master = this._master();
      const masterUp = master && master.alive;

      // 1. heartbeats
      for (const n of this.nodes) {
        if (!n.alive) continue;
        if (now - n.lastHb >= HEARTBEAT_MS) {
          const span = Math.max(1, now - n.lastHb);
          n.lastHb = now;
          n.hbSeq++;
          n.latencyMs = Math.max(1, n.latencyMs * 0.6 + rand(2, 12) * 0.4);
          // reported speed = hashes actually done since the previous heartbeat (HeartbeatPacket.hashes_per_sec)
          const measured = this._computes(n) && running ? (n.hbHashes / span) / 1e3 : 0;
          n.mhs = measured > 0 ? measured * rand(0.97, 1.03) : 0;
          n.hbHashes = 0;
          if (n.chunkId != null) {
            const c = this.chunks[n.chunkId];
            if (c) c.checkpoint = c.cursor; // checkpoint_index travels inside the heartbeat
          }
          if (n.status === "joining" && (masterUp || n.role === "master")) {
            n.status = "online";
            this._log("ok", `${n.name} online · ${this._modeLabel(n)}`, "node");
          }
        }
      }

      // 2. failure detection (timeout > 1000 ms)
      for (const n of this.nodes) {
        if (n.alive || n.status === "offline") continue;
        if (now - n.lastHb > TIMEOUT_MS) {
          n.status = "offline";
          n.mhs = 0;
          if (n.role === "master") this._failover(n);
          else this._log("warn", `Heartbeat timeout: ${n.name} silent for ${Math.round(now - n.lastHb)} ms → marked OFFLINE`, "fault");
          this._recoverChunkOf(n);
        }
      }

      if (!this.job) return;
      const m2 = this._master();
      const coordinatorUp = m2 && m2.alive && m2.status === "online";

      // 3. compute
      if (running) {
        for (const n of this.nodes) {
          if (!this._computes(n) || !n.alive || n.status !== "online") continue;
          let budget = dt; // ms of compute time available this tick
          while (budget > 0 && this.status === "running") {
            if (n.chunkId == null) {
              if (!coordinatorUp || now < n.idleUntil) { n.idleMs += budget; break; }
              const c = this._nextChunk();
              if (!c) { n.idleMs += budget; break; }
              c.status = ST.IN_FLIGHT;
              c.nodeId = n.id;
              n.chunkId = c.id;
              if (c.recoveredFrom) {
                const r = this.recoveries.find((x) => x.chunkId === c.id && x.toNodeId == null);
                if (r) { r.toNodeId = n.id; r.tResumed = this.elapsedMs; }
                this._log("ok", `Chunk #${c.id} resumed by ${n.name} from checkpoint ${MS.fmtInt(c.checkpoint)}`, "recovery");
                c.recoveredFrom = null;
              }
            }
            const c = this.chunks[n.chunkId];
            const rate = nodeBaseMhs(n) * 1e3; // hashes per ms
            const remaining = c.end - c.cursor;
            const can = Math.floor(rate * budget);
            const step = Math.min(remaining, can);
            const before = c.cursor;
            c.cursor += step;
            n.hashesDone += step;
            n.hbHashes += step;
            const used = step / rate;
            n.busyMs += used;
            budget -= Math.max(used, 0.0001);
            const ti = this.job.targetIndex;
            if (ti >= before && ti < c.cursor) {
              this._found(n, c, ti);
              break;
            }
            if (c.cursor >= c.end) {
              c.status = ST.COMPLETED;
              c.checkpoint = c.end;
              n.chunkId = null;
              n.chunksDone++;
              n.idleUntil = now + n.latencyMs * 2; // MSG_TASK_RESULT → MSG_REQUEST_TASK round trip
            } else break;
          }
        }
        if (this.status === "running" && this.chunks.every((c) => c.status === ST.COMPLETED)) {
          this.status = "exhausted";
          this._log("warn", `Keyspace exhausted in ${MS.fmtDuration(this.elapsedMs)} — no password of length ${this.job.length} matches this hash`, "job");
        }
      }

      // 4. throughput history (sparkline)
      if (running && this.elapsedMs - this.lastSample >= 500) {
        this.lastSample = this.elapsedMs;
        this.history.push(this._throughput());
        if (this.history.length > 120) this.history.shift();
      }
    }

    _nextChunk() {
      let best = null;
      for (const c of this.chunks) {
        if (c.status === ST.RECOVERING) return c; // recovering chunks are prioritised
        if (!best && c.status === ST.PENDING) best = c;
      }
      return best;
    }

    _recoverChunkOf(n) {
      if (n.chunkId == null) return;
      const c = this.chunks[n.chunkId];
      n.chunkId = null;
      if (!c || c.status !== ST.IN_FLIGHT) return;
      const lost = c.cursor - c.checkpoint;
      c.recoveredFrom = n.id;
      c.status = ST.RECOVERING;
      c.nodeId = null;
      const rec = {
        t: this.elapsedMs, chunkId: c.id, fromNodeId: n.id, toNodeId: null,
        checkpoint: c.checkpoint, start: c.start, end: c.end, lostHashes: lost,
        savedPct: ((c.checkpoint - c.start) / (c.end - c.start)) * 100,
      };
      this.recoveries.push(rec);
      c.cursor = c.checkpoint; // roll back to last reported checkpoint
      this._log("warn", `Chunk #${c.id} rolled back to checkpoint ${MS.fmtInt(c.checkpoint)} (${rec.savedPct.toFixed(0)}% kept, ${MS.fmtCompact(lost)} hashes redone) → RECOVERING`, "recovery");
    }

    _failover(dead) {
      const shadow = this.nodes.find((x) => x.role === "shadow" && x.alive && x.status === "online");
      this._log("error", `Master ${dead.name} missed heartbeats → primary coordinator lost`, "fault");
      dead.role = "worker";
      if (!shadow) {
        this.status = this.status === "running" ? "halted" : this.status;
        dead.role = "master";
        this._log("error", "No Shadow Master available — cluster halted (single point of failure)", "fault");
        return;
      }
      shadow.role = "master";
      this._recoverChunkOf(shadow); // new Master stops computing; its chunk goes back to the queue
      this._log("ok", `👑 Shadow Master ${shadow.name} promoted to Master — replicated queue state restored (${this.chunks.filter((c) => c.status === ST.COMPLETED).length}/${this.chunks.length} chunks done)`, "failover");
      if (this.status === "halted") this.status = "running";
    }

    _found(n, c, idx) {
      c.cursor = idx + 1;
      c.status = ST.COMPLETED;
      n.chunkId = null;
      const password = MS.indexToPassword(idx, this.job.length);
      this.status = "found";
      this.result = {
        password, index: idx, nodeId: n.id, nodeName: n.name, chunkId: c.id,
        elapsedMs: this.elapsedMs, hashesComputed: this.nodes.reduce((s, x) => s + x.hashesDone, 0),
      };
      for (const x of this.nodes) x.mhs = 0;
      this._log("ok", `🔑 Password recovered by ${n.name}: "${password}" at index ${MS.fmtInt(idx)} (chunk #${c.id}) in ${MS.fmtDuration(this.elapsedMs)}`, "found");
    }

    _throughput() {
      if (this.status !== "running") return 0;
      return this.nodes.reduce((s, n) => s + (n.alive && n.status === "online" ? n.mhs : 0), 0);
    }

    /* ------------------------------------------------------------ snapshot */
    async getState() {
      const now = performance.now();
      const counts = [0, 0, 0, 0];
      let scanned = 0;
      for (const c of this.chunks) {
        counts[c.status]++;
        scanned += c.cursor - c.start;
      }
      let busy = 0, idle = 0;
      for (const n of this.nodes) if (this._computes(n)) { busy += n.busyMs; idle += n.idleMs; }
      const master = this._master();
      return {
        mode: "demo",
        job: this.job
          ? {
              status: this.status,
              targetHash: this.job.targetHash,
              targetLabel: this.job.targetLabel,
              length: this.job.length,
              chunkSize: this.job.chunkSize,
              keyspace: this.job.keyspace,
              totalChunks: this.chunks.length,
              elapsedMs: this.elapsedMs,
              scanned,
              result: this.result,
            }
          : { status: "idle" },
        activeMasterId: master ? master.id : null,
        nodes: this.nodes.map((n) => {
          const c = n.chunkId != null ? this.chunks[n.chunkId] : null;
          return {
            id: n.id, name: n.name, host: n.host, role: n.role, mode: n.mode, device: n.device,
            cpuThreads: n.cpuThreads, antiChoke: n.antiChoke, threadsAllowed: n.threadsAllowed,
            status: n.status, alive: n.alive,
            latencyMs: n.latencyMs,
            heartbeatAgeMs: now - n.lastHb, hbSeq: n.hbSeq,
            chunkId: n.chunkId,
            chunkProgress: c ? (c.cursor - c.start) / (c.end - c.start) : 0,
            checkpoint: c ? c.checkpoint : null,
            mhs: n.alive && n.status === "online" ? n.mhs : 0,
            cpuLoad: !n.alive || n.status !== "online" ? 0 : n.role === "master" ? 4 : n.chunkId == null ? 3 : n.mode === "gpu" ? 2 : (n.threadsAllowed / n.cpuThreads) * 100,
            chunksDone: n.chunksDone, hashesDone: n.hashesDone,
          };
        }),
        chunks: this.chunks.map((c) => ({ id: c.id, start: c.start, end: c.end, checkpoint: c.checkpoint, cursor: c.cursor, nodeId: c.nodeId, status: c.status })),
        metrics: {
          throughputMhs: this._throughput(),
          history: this.history.slice(),
          scannedPct: this.job ? (scanned / this.job.keyspace) * 100 : 0,
          pending: counts[ST.PENDING], inFlight: counts[ST.IN_FLIGHT], completed: counts[ST.COMPLETED], recovering: counts[ST.RECOVERING],
          efficiencyPct: busy + idle > 0 ? (busy / (busy + idle)) * 100 : null,
        },
        recoveries: this.recoveries.slice(-12),
        events: this.events.slice(-80),
      };
    }

    async getBenchmarks() {
      return MS.BENCHMARKS;
    }
  }

  MS.DemoBackend = DemoBackend;
  MS.estimateNodeMhs = (n) => (n.role === "master" ? 0 : nodeBaseMhs(n));
})();
