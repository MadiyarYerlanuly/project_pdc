# Mini-Spark — Web Frontend (Cluster Control Center)

Control center and visualization layer for the cluster, covering every item in
**PROJECT_WIKI.md § 4.2**:

| Wiki requirement | Where in the UI |
| --- | --- |
| Upload a file or enter a SHA-256 target | Control Center → Job (Hash / File / Test password) |
| Password length, chunk size, start / stop / reset | Job card |
| Add / configure nodes, roles, GPU vs CPU (Anti-Choke) | Nodes tab |
| Live node status: online/offline, heartbeat latency, chunk, progress, MH/s | Live nodes table + Cluster map |
| Trigger a worker crash / kill the Master | Fault tolerance card, ⏻ buttons in the table |
| See checkpoint recovery and Shadow Master promotion | Fault tolerance card, Keyspace strip (amber = recovering), Event log |
| Cluster throughput, % keyspace, chunk status, load-balance efficiency | KPI tiles + H1/H2/H3 panel |
| Password recovered: string, index, node, total time | Result overlay |
| Scaling benchmarks (Serial vs OpenMP SIMD vs OpenCL GPU, weak/strong) | Benchmarks tab (data from `src_w10`) |

Plain HTML/CSS/JS, **no build step and no CDN** — the demo hotspot may have no internet.

## Run

- **Quick look:** open `index.html` in a browser. With no backend it starts the
  built-in **demo simulator** (pill in the top-right says *Demo simulator*).
- **With the real backend:** serve this folder from the Master laptop's backend
  (e.g. as static files at `/`) bound to `0.0.0.0:8000`. Other laptops open
  `http://<master-ip>:8000`. The app auto-detects `/api/health` and switches to *Live*.
- Click the connection pill to force `Auto / Live / Demo` or set the backend URL.
  `?mode=demo` in the URL also forces the simulator.

## Files

```
index.html          layout
css/styles.css      "fresh glass" theme (aurora background + frosted cards)
js/sha256.js        pure-JS SHA-256 (crypto.subtle is unavailable on http://192.168.x.x)
js/keyspace.js      Base-36 index <-> password, same CHARSET/order as sha256_serial.c
js/api.js           backend interface, API contract, constants, benchmark data
js/simulator.js     demo backend: queue, 500 ms heartbeats, 1 s timeout, checkpoint rollback, Shadow Master failover
js/charts.js        tiny SVG charts
js/app.js           UI controller
```

## Backend API contract

The full contract (endpoints + state JSON shape) is documented at the top of
`js/api.js`. Summary:

```
GET  /api/health                 POST /api/nodes        PATCH/DELETE /api/nodes/:id
GET  /api/state  (polled 500 ms) POST /api/fault/kill-node {nodeId}
POST /api/job {targetHash,length,chunkSize}            POST /api/fault/kill-master
POST /api/job/target-file (multipart "file")           POST /api/fault/revive {nodeId}
POST /api/job/start | /stop | /reset                   GET  /api/benchmarks (optional)
```

Chunk `status` uses the same codes as `ChunkStatus` in `framework_types.h`
(0 pending, 1 in-flight, 2 completed, 3 recovering). Node `mhs` should come from
`HeartbeatPacket.hashes_per_sec`, `checkpoint` from `current_index`.

## Notes on the demo numbers

- Intel Iris Xe GPU (197.48 MH/s) and CPU OpenMP curve (2.38 → 10.62 MH/s) are **measured** W10 values.
- Apple M2, AMD 680M and RTX 3050 speeds are **estimates** for the simulator only — replace after W12.
- The simulator can only "recover" targets created in the *Test password* tab; a pasted unknown hash
  scans the whole keyspace and ends with *Not found* (the real C engine does the actual cracking).
