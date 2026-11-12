# 📘 Project Technical Wiki & Web Dashboard Specification (`Mini-Spark`)

> **Target Audience:** Team Developers, Web Frontend/Backend Engineers, and New Contributors  
> **Course:** Parallel & Distributed Computing (Instructor: Dr. Mohammed Alaa Ala'anzy)  
> **Repository:** `https://github.com/MadiyarYerlanuly/project_pdc-`

This Wiki contains **all architectural details, mathematical formulas, C/OpenCL engine contracts, and Web Dashboard specifications** required to build and integrate the graphical interface without needing to ask for clarifications.

---

## 1. Executive Overview: What Are We Building?

We are building **Mini-Spark**: a custom, fault-tolerant distributed computing engine written in C/C++ (using **MPI**, **OpenMP + AVX2 SIMD**, and **OpenCL GPU Offloading**).

To demonstrate and benchmark the engine on a real-world problem, our payload application is **Distributed Cryptographic Forensics (SHA-256 Password Recovery)**:
1. A user uploads a locked forensic container/archive (or inputs a target 64-character hex **SHA-256 digital signature**).
2. A **Master Node** partitions the total password search space (keyspace) into small numerical ranges called **Chunks** and dynamically distributes them across **Worker Nodes** (up to 5 laptops over Wi-Fi).
3. Each **Worker Node** evaluates millions of candidate passwords per second using its **GPU (via OpenCL)** or **CPU (via OpenMP + SIMD)**.
4. If any Worker laptop disconnects or crashes mid-computation, the Master detects the lost **Heartbeat**, restores the last **Checkpoint**, and reassigns the unfinished chunk to a surviving Worker without stopping the cluster.

---

## 2. The 3 Core Scientific Hypotheses (Must Be Visible in the Web UI)

The Professor evaluates our project against three formal hypotheses from our approved Proposal:

* **H1 (Hardware-Agnostic Compute Acceleration & Anti-Choke):** Offloading SHA-256 hashing to any vendor's GPU via **OpenCL** (Intel Iris Xe, Apple Silicon M1/M2/M3, AMD, NVIDIA) and using **OpenMP + SIMD** with 2 reserved CPU threads (`Anti-Choke Guard`) achieves huge speedups (`85x+` on GPU, `4x+` on CPU) while keeping host CPU load low so OS and MPI network threads never freeze.
* **H2 (Fault Tolerance via Heartbeats & Checkpointing):** When a worker node crashes or loses Wi-Fi, the Master detects the missing heartbeat within `500 ms` – `1000 ms` and reassigns the uncompleted portion of the chunk from its last checkpoint with `<15%` recovery overhead.
* **H3 (Dynamic Load Balancing Across Heterogeneous Laptops):** Because our 5 laptops have different speeds, the Master uses a dynamic pull-based task queue (`TaskChunk`) to maintain `>90%` scaling efficiency (measured at `94.88% – 96.06%`).

---

## 3. Team Modules & Ownership (`S1` – `S5`)

| Module ID | Owner | Component Name | Technical Scope |
| :--- | :--- | :--- | :--- |
| **S1** | Atabek Bakhytzhanov (`240107104`) | **The Scheduler** | Keyspace partitioning, `TaskChunk` queue, dynamic pull-based load balancing |
| **S2** | Begzhan Imangali (`240107042`) | **The Networker** | Asynchronous non-blocking MPI (`MPI_Isend`, `MPI_Irecv`, `MPI_Iprobe`) & Heartbeats |
| **S3** | Karzhaubay Bakdaulet (`240107105`) | **The Rescuer** | Heartbeat timeout monitor, Checkpoint recovery, and `Rank 1` Shadow Master failover |
| **S4** | Yerkebulan Kenzhegali (`240107051`) | **The Accelerator** | Universal **OpenCL GPU** kernel + Multi-core **OpenMP + SIMD** with Anti-Choke guard |
| **S5** | Madiyar Yerlanuly (`240107040`) | **Data Sci & Crypto** | FIPS 180-4 SHA-256 algorithm, Base-36 keyspace math, Strong/Weak scaling analytics |

---

## 4. Deep Technical Internals (How Everything Works Under the Hood)

### 4.1 How Passwords Are Generated Without Dictionary Files (Base-36 Keyspace Math)
We **never** send `.txt` password lists over the network. Instead, we use a 36-character alphabet:
```text
CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789" (Length = 36)
```
For a password of length $L$, the total number of combinations (`TOTAL_KEYSPACE`) is $36^L$:
* $L = 4 \implies 36^4 = 1,679,616$ combinations (`"aaaa"` to `"9999"`)
* $L = 5 \implies 36^5 = 60,466,176$ combinations (`"aaaaa"` to `"99999"`)
* $L = 6 \implies 36^6 = 2,176,782,336$ combinations (`"aaaaaa"` to `"999999"`)

Every integer `index` $\in [0, 36^L - 1]$ maps 1-to-1 to a password string via Base-36 conversion. The Master only sends two 64-bit numbers (`start_index` and `end_index`) to a Worker!

#### Reference Implementations for Web Developers (Python & JavaScript):
```python
# Python: Convert index <-> password
CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789"

def index_to_password(index: int, length: int) -> str:
    chars = []
    for _ in range(length):
        chars.append(CHARSET[index % 36])
        index //= 36
    return "".join(reversed(chars))

def password_to_index(password: str) -> int:
    idx = 0
    for ch in password:
        idx = idx * 36 + CHARSET.index(ch)
    return idx
```
```javascript
// JavaScript (Frontend/Node.js): Convert index <-> password
const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function indexToPassword(index, length) {
  let tmp = BigInt(index);
  let out = new Array(length);
  for (let pos = length - 1; pos >= 0; pos--) {
    out[pos] = CHARSET[Number(tmp % 36n)];
    tmp = tmp / 36n;
  }
  return out.join("");
}
```

---

### 4.2 Why We Use `Anti-Choke CPU Guard` + `OpenCL GPU Offloading`
During Week 8–10 benchmarks on an 8-thread laptop (`Intel Core i5-1135G7`), we discovered a critical system behavior:
* Running OpenMP on **all 8 CPU threads (100% CPU load)** caused OS thread starvation and thermal contention—throughput actually **dropped** from `7.13 MH/s` (at 6 threads) down to `6.63 MH/s` (at 8 threads), and network Heartbeats experienced lag spikes!
* Therefore, our engine has two execution modes selectable per Worker node:
  1. **OpenCL GPU Mode (Recommended):** Offloads 100% of SHA-256 hashing onto the laptop's GPU (`src_w8_w9/kernels/sha256_kernel.cl`). Works on **Intel Iris Xe**, **Mac Apple M1/M2/M3**, **AMD Radeon**, and **NVIDIA**. Delivers **`117 – 197.48 MH/s`** while keeping **CPU usage at `~2%`**!
  2. **OpenMP + SIMD Anti-Choke Mode (CPU Baseline / Fallback):** Uses `#pragma omp parallel for` + `#pragma omp simd` on `max_threads - 2` threads, leaving 2 CPU threads free for the OS, Web UI, and MPI Heartbeats.

---

### 4.3 Core C Data Structures (`src_w6_w7/include/framework_types.h`)
All modules communicate using these exact structures:

```c
/* Chunk lifecycle states */
typedef enum {
    CHUNK_PENDING    = 0,  /* Waiting in Master queue                     */
    CHUNK_IN_FLIGHT  = 1,  /* Currently assigned to an active Worker      */
    CHUNK_COMPLETED  = 2,  /* Finished scanning (no match or match found) */
    CHUNK_RECOVERING = 3   /* Worker died! Re-queued from last checkpoint */
} ChunkStatus;

/* Task Chunk descriptor */
typedef struct {
    uint32_t chunk_id;
    uint64_t start_index;       /* Starting password index in keyspace        */
    uint64_t end_index;         /* Ending password index (exclusive)          */
    uint64_t checkpoint_index;  /* Last verified progress reported by worker  */
    int      assigned_rank;     /* Worker Node ID currently owning this chunk */
    int      status;            /* ChunkStatus (0..3)                         */
} TaskChunk;

/* Heartbeat & Checkpoint packet sent every 500ms from Worker -> Master */
typedef struct {
    int      worker_rank;
    uint32_t chunk_id;
    uint64_t current_index;     /* Checkpoint progress inside the chunk       */
    double   hashes_per_sec;    /* Current local throughput (MH/s)            */
} HeartbeatPacket;
```

---

### 4.4 Fault Tolerance & Shadow Master Protocol (Module S3)
1. **Worker Failure Recovery:**
   * Every active Worker sends a `HeartbeatPacket` every `500 ms` containing its `current_index` (checkpoint) and `hashes_per_sec`.
   * If a Worker does not send a heartbeat within `1000 ms` (or when a user clicks **"Simulate Crash"** in the Web UI), the Master marks the Worker as `OFFLINE`.
   * The Master takes the dead Worker's `TaskChunk`, sets `start_index = checkpoint_index` (so already-checked passwords are **not** recomputed!), sets `status = CHUNK_RECOVERING`, and assigns the remaining range to a healthy Worker.
2. **Master Failure Recovery (`Shadow Master` on Node 1):**
   * To prevent the Master node from being a Single Point of Failure (SPOF), Worker #1 (`Rank 1`) acts as the **Shadow Master (Hot Standby)**.
   * The Master continuously mirrors the `TaskChunk` queue state to the Shadow Master.
   * If the primary Master goes offline, the Shadow Master promotes itself to Master and continues orchestrating the remaining Workers.

---

## 5. Existing Codebase Map & How Backend Can Call It

```text
project_pdc-/
├── run_all_demo.py                    # Runs all C & OpenCL stages sequentially
├── PROJECT_WIKI.md                    # This technical wiki for developers
├── PROJECT_TEAM_GUIDE.md              # Overview in Russian
├── proposal/
│   ├── Project_Proposal_Framework.pdf # Approved Proposal
│   └── Progress_Report_W10.pdf        # Week 10 Official Progress Report
├── src_w6_w7/                         # Stage 1: Serial SHA-256 C implementation
│   ├── include/framework_types.h      # Core C structs
│   ├── include/sha256.h               # SHA-256 C header
│   └── src/
│       ├── sha256_serial.c            # FIPS 180-4 SHA-256 + index_to_password()
│       └── main_w6_w7.c               # Single-core baseline (~2.38 MH/s)
├── src_w8_w9/                         # Stage 2: OpenMP+SIMD, OpenCL GPU & Dynamic Scheduler
│   ├── kernels/sha256_kernel.cl       # Universal OpenCL GPU kernel (Intel/Mac/AMD/NVIDIA)
│   ├── src/main_w8_w9.c               # OpenMP+SIMD + Heterogeneous Dynamic Balancer
│   └── run_opencl_gpu_bench.py        # Direct Python->OpenCL.dll GPU execution script
└── src_w10/                           # Stage 3: Strong & Weak Scaling Benchmark Suite
    ├── src/main_w10_scaling.c         # Generates Strong (1..8 threads) & Weak (1..4 nodes) data
    └── results_w10_scaling.csv        # Exported benchmark CSV for charts
```

---

## 6. Web Dashboard Specification (What the Web Team Needs to Build)

The Web Application should act as the **Forensic Control Center (`Mini-Spark Dashboard`)**. Below are the exact screens, controls, and JSON API contracts needed.

### 6.1 Required UI Panels (4 Main Sections)

#### Panel 1: Forensic Target & Job Configuration
* **File Dropzone / Container Input:**
  * Allows dragging & dropping any file/archive (or generating a demo locked container).
  * When a file is dropped (or a demo password like `"kz99"` or `"zzzz4"` is set for testing), the UI displays:
    * **Target SHA-256 Signature (64-hex string):** e.g., `80e79d7222369fd676c90ccad4b0c027178e4a91cc99dab0c1c6371e7ce4e200`
    * **Password Length ($L$):** Selector for `4 chars (1.68M)`, `5 chars (60.47M)`, or `6 chars (2.17B)`.
    * **Chunk Size:** Slider or dropdown (e.g., `100,000` to `2,000,000` hashes per chunk).

#### Panel 2: Cluster Topology & Node Management (5 Laptops)
* **Add / Configure Node Modal:**
  * Fields: `Node Name` (e.g., *Atabek-Master*, *Yerkebulan-Lenovo-GPU*, *Madiyar-MacBook*), `IP Address / Host`, `Role` (`MASTER`, `SHADOW_MASTER`, `WORKER`), `Compute Backend` (`OPENCL_GPU` or `OPENMP_SIMD_CPU`), and `Anti-Choke CPU Threads` (e.g., `6 / 8 threads`).
* **Node Cards (5 Cards on Screen):**
  * Each card displays:
    * Node Name, IP, Role badge (`👑 Master`, `🛡️ Shadow Master`, `⚙️ Worker`).
    * Hardware badge (`Intel Iris Xe GPU - 80 CUs`, `Apple M2 GPU`, `OpenMP 6 Threads`).
    * Live Heartbeat indicator: `🟢 ONLINE (Heartbeat: 85ms)` or `🔴 OFFLINE (Timeout > 1000ms)`.
    * Current Chunk ID & Local Progress Bar (`Chunk #14 — 65%`).
    * Local Speed (`197.48 MH/s`) and Host CPU Load (`2%`).
    * **Action Button on Card:** `[ 💥 Simulate Crash / Disconnect ]` and `[ 🔄 Revive Node ]`.

#### Panel 3: Live Execution, Chunk Map & Telemetry
* **Primary Action Bar:** `[ 🚀 Start Distributed Job ]` `[ ⏸️ Pause ]` `[ 🔁 Reset Cluster ]`
* **Global Telemetry Counters:**
  * **Total Cluster Speed:** e.g., `241.55 MH/s`
  * **Keyspace Scanned:** Progress bar (`45.2% — 27,300,000 / 60,466,176 hashes`)
  * **Load Balancing Efficiency (H3):** e.g., `96.06%`
  * **Active Checkpoints Saved (H2):** e.g., `142 checkpoints`
* **Visual Chunk Grid (Interactive Matrix of Chunks):**
  * A grid of small squares (e.g., 24 to 64 chunks) color-coded in real time:
    * ⬜ Grey = `CHUNK_PENDING`
    * 🟦 Blue (pulsing) = `CHUNK_IN_FLIGHT` (shows which Worker owns it)
    * 🟧 Orange (flashing) = `CHUNK_RECOVERING` (Worker crashed! Restoring from checkpoint)
    * 🟩 Green = `CHUNK_COMPLETED`
    * 🟨 Gold Star = **MATCH FOUND IN THIS CHUNK!**
* **Live Event & Fault-Tolerance Log (Terminal Feed):**
  * Streams timestamped cluster events:
    * `[12:04:01] [Scheduler S1] Dispatched Chunk #4 (559,872 .. 699,840) -> Worker Rank 2 (OpenCL GPU)`
    * `[12:04:02] [Rescuer S3] ⚠️ ALERT: Worker Rank 3 heartbeat lost (>500ms)! Marking node OFFLINE.`
    * `[12:04:02] [Rescuer S3] 🔄 Restored Chunk #7 from Checkpoint index 910,200 (saved 55% work). Reassigned to Worker Rank 1.`

#### Panel 4: Forensic Recovery Success Banner & Scaling Charts
* When the target hash is matched, display a high-impact **Forensic Match Modal / Banner**:
  * **Recovered Password:** `'zzzz4'` (with matched keyspace index `#60,466,144`)
  * **Cracked By:** `Worker Rank 1 (Intel Iris Xe OpenCL GPU)`
  * **Total Elapsed Time:** `0.31 seconds`
  * **Charts Tab (from `src_w10/results_w10_scaling.csv`):**
    * Bar chart comparing `1-Core Serial (2.38 MH/s)` vs `OpenMP+SIMD 6-Threads (9.38 MH/s)` vs `OpenCL GPU (197.48 MH/s)`.
    * Line chart showing Weak Scaling efficiency across `1, 2, 3, 4` Worker nodes (`100% -> 98.2% -> 96.5% -> 94.9%`).

---

### 6.2 Recommended Backend <-> Frontend JSON API Contract

If the web team uses **FastAPI / Flask (Python)** or **Node.js** for the backend, here is the clean JSON structure for WebSocket / REST polling (`GET /api/cluster/state`):

```json
{
  "job": {
    "status": "RUNNING",
    "target_file": "evidence_vault.zip",
    "target_sha256": "a644dcdf73fa45b6c6d1ecaa46181f1579a2b78e8d924d23c1b5f082807a1c42",
    "pass_length": 5,
    "total_keyspace": 60466176,
    "hashes_checked": 28450000,
    "cluster_throughput_mhs": 225.40,
    "load_balance_efficiency_pct": 96.06,
    "elapsed_sec": 1.42,
    "found": false,
    "recovered_password": null,
    "matched_index": null
  },
  "nodes": [
    {
      "rank": 0,
      "name": "Node 0 (Atabek - Master)",
      "ip": "192.168.1.10",
      "role": "MASTER",
      "status": "ONLINE",
      "backend": "CPU_COORDINATOR",
      "cpu_load_pct": 4.2,
      "throughput_mhs": 0.0,
      "last_heartbeat_ms": 12
    },
    {
      "rank": 1,
      "name": "Node 1 (Yerkebulan - Lenovo)",
      "ip": "192.168.1.11",
      "role": "SHADOW_MASTER",
      "status": "ONLINE",
      "backend": "OPENCL_GPU (Intel Iris Xe - 80 CUs)",
      "cpu_load_pct": 2.1,
      "throughput_mhs": 197.48,
      "current_chunk_id": 12,
      "chunk_progress_pct": 74.0,
      "last_heartbeat_ms": 45
    },
    {
      "rank": 2,
      "name": "Node 2 (Karzhaubay - Worker)",
      "ip": "192.168.1.12",
      "role": "WORKER",
      "status": "OFFLINE",
      "backend": "OPENMP_SIMD (6/8 Threads)",
      "cpu_load_pct": 0.0,
      "throughput_mhs": 0.0,
      "current_chunk_id": 9,
      "chunk_progress_pct": 42.0,
      "last_heartbeat_ms": 1540
    }
  ],
  "chunks": [
    {
      "chunk_id": 8,
      "start_index": 16000000,
      "end_index": 18000000,
      "checkpoint_index": 18000000,
      "assigned_rank": 1,
      "status": "COMPLETED"
    },
    {
      "chunk_id": 9,
      "start_index": 18000000,
      "end_index": 20000000,
      "checkpoint_index": 18840000,
      "assigned_rank": 1,
      "status": "RECOVERING"
    }
  ]
}
```

### 6.3 Required Control Endpoints for the UI Buttons
* `POST /api/job/start` — Body: `{ "target_sha256": "...", "pass_length": 4, "chunk_size": 209952 }`
* `POST /api/node/add` — Body: `{ "name": "Node 5", "ip": "192.168.1.15", "role": "WORKER", "backend": "OPENCL_GPU", "threads": 6 }`
* `POST /api/chaos/kill-node` — Body: `{ "rank": 2 }` *(Simulates node crash: stops heartbeats for `rank`, triggers `S3 Rescuer` checkpoint recovery in the UI log, and reassigns its in-flight chunk!)*
* `POST /api/chaos/revive-node` — Body: `{ "rank": 2 }` *(Brings the node back online to pull new chunks).*

---

## 7. Quick Start for New Developers

1. **Clone the repository:**
   ```bash
   git clone https://github.com/MadiyarYerlanuly/project_pdc-.git
   cd project_pdc-
   ```
2. **Run the complete engine demo (Weeks 6–10) with a single command:**
   ```bash
   python run_all_demo.py
   ```
3. **Run only the OpenCL GPU benchmark:**
   ```bash
   python src_w8_w9/run_opencl_gpu_bench.py
   ```
4. **Read the experimental scaling data (for frontend charts):**
   * See [`src_w10/results_w10_scaling.csv`](./src_w10/results_w10_scaling.csv) and [`src_w10/PROGRESS_REPORT_W10.md`](./src_w10/PROGRESS_REPORT_W10.md).
