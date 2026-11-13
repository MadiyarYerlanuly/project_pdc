# Mini-Spark cluster runtime (Master + Workers)

Real backend for the dashboard in `frontend/`. **Python 3.8+ standard library only — nothing to install.**

```
project_pdc/
├── frontend/            dashboard (served by the Master)
├── cluster/
│   ├── master.py        Master: task queue, heartbeats, recovery, API, web server
│   ├── worker.py        Worker: registers hardware, pulls chunks, hashes, heartbeats
│   └── engine/ms_cpu_engine.c   native CPU engine (built automatically by worker.py)
└── src_w8_w9/kernels/sha256_kernel.cl   GPU kernel, used by worker.py via OpenCL
```

## Run (one laptop first)

```bash
# terminal 1 — the Master laptop
python3 cluster/master.py
# terminal 2 — same laptop also computes
python3 cluster/worker.py --master localhost:8000
```

Open **http://localhost:8000** — the pill shows *Live*. Test with the *Test password* tab,
length 5–6, chunk size 10 M.

## Add the other laptops

1. All laptops on the **same Wi-Fi** (a phone hotspot is safest: campus Wi-Fi often blocks laptop-to-laptop traffic).
2. The Master prints its address, e.g. `http://192.168.1.10:8000`. Allow port 8000 in its firewall.
3. On each other laptop, in the project folder:
   ```bash
   python3 cluster/worker.py --master 192.168.1.10:8000
   ```
   (`python` instead of `python3` on Windows.) The laptop appears in the dashboard within a second.

Options: `--name my-laptop`, `--mode gpu|cpu|auto` (default: GPU if OpenCL works).

## Engines

| Engine | When | Notes |
| --- | --- | --- |
| OpenCL GPU | OpenCL driver + GPU found | runs `sha256_kernel.cl` in ~100 ms batches; host CPU stays low (H1) |
| C engine (pthreads) | `cc` / `clang` / `gcc` present (macOS: Xcode Command Line Tools) | Anti-Choke: logical threads − 2 |
| Python fallback | no compiler (common on Windows) | hashlib + multiprocessing, slower |

## Fault-tolerance demo (H2)

- **Kill worker** in the dashboard → the worker goes silent (simulated crash). After 1 s without
  heartbeats it is marked OFFLINE, its chunk rolls back to the last checkpoint and is re-queued
  with priority. **Restart** brings it back. Pressing **Ctrl+C** on a worker is a real crash and
  is handled the same way; run the command again to rejoin.
- **Kill Master** → the coordinator stops dispatching and misses heartbeats; the Shadow Master
  is promoted with the replicated queue state. The first worker to join is the Shadow Master.
  *Limitation:* the web server itself keeps running — a standby Master in a separate process is the W11 task (S3).

## API

Dashboard endpoints are documented in `frontend/js/api.js`. Worker protocol:

| Endpoint | Body | Reply |
| --- | --- | --- |
| `POST /api/worker/register` | `{name, cpuThreads, gpu:{available,name,computeUnits}, engine, mode, os}` | `{nodeId, role, config}` |
| `POST /api/worker/heartbeat` (every 500 ms) | `{nodeId, chunkId, currentIndex, mhs, cpuLoad, rttMs, mode}` | `{command: null\|"abort"\|"die", config}` |
| `POST /api/worker/request` | `{nodeId}` | `{chunk:{id, from, end}, job:{targetHash, length}}` or `{chunk:null, retryMs}` |
| `POST /api/worker/result` | `{nodeId, chunkId, found, index?, hashes, elapsed}` | `{ok}` — a match is re-verified by the Master |
| `GET /api/worker/status?nodeId=` | — | `{alive}` (used by a "killed" worker to wait for Restart) |
