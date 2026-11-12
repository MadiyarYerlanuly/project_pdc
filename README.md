# Distributed Computing Engine: A Resilient Mini-Framework for Cryptographic Forensics

**Course:** Parallel & Distributed Computing (Instructor: Dr. Mohammed Alaa Ala'anzy)  
**Architecture:** Mini-Spark C/C++ Resilient Engine (MPI + OpenMP SIMD + Universal OpenCL GPU Offloading)

---

## Documentation & Reports

* **Technical Wiki & Web Spec (English):** [PROJECT_WIKI.md](./PROJECT_WIKI.md)
* **Гайд по проекту (на русском):** [PROJECT_TEAM_GUIDE.md](./PROJECT_TEAM_GUIDE.md)
* **Approved Project Proposal (PDF):** [proposal/Project_Proposal_Framework.pdf](./proposal/Project_Proposal_Framework.pdf)
* **Week 10 Progress Report (PDF):** [proposal/Progress_Report_W10.pdf](./proposal/Progress_Report_W10.pdf) | [Markdown](./src_w10/PROGRESS_REPORT_W10.md)

---

## Project Overview

**Mini-Spark** is a fault-tolerant distributed execution engine built for heterogeneous laptop clusters. We evaluate the engine using a compute-intensive forensic task: **Distributed SHA-256 Password Recovery**.

Key engineering features:
1. **Zero-Memory Base-36 Keyspace Partitioning:** Instead of transferring large dictionary files over Wi-Fi, the Master node slices the mathematical search space ($36^L$) into compact numerical ranges (`TaskChunk`) and dynamically schedules them across Worker nodes.
2. **Universal OpenCL GPU Offloading & Anti-Choke CPU Guard (H1):** Offloads heavy SHA-256 hashing onto any integrated or discrete GPU (`Intel Iris Xe`, `Apple Silicon M-series`, `AMD`, `NVIDIA`) via OpenCL while keeping host CPU load around `~2%`. When running in CPU mode (`OpenMP + SIMD`), the engine reserves 2 logical CPU threads for OS and network responsiveness so MPI heartbeats never lag.
3. **Fault Tolerance & Shadow Master (H2):** Workers report periodic heartbeats (`500 ms`) with checkpoint progress. If a Worker disconnects, the Master rolls the interrupted chunk back to its last checkpoint and reassigns the remaining work to a healthy node. A `Shadow Master` standby node protects the cluster against primary Master failure.
4. **Dynamic Load Balancing (H3):** Pull-based chunk scheduling adapts automatically to laptops with different compute speeds, maintaining `>90%` cluster efficiency.

---

## Repository Structure

```text
project_pdc-/
├── README.md                          # Project overview, benchmarks & run instructions
├── PROJECT_WIKI.md                    # Technical Wiki & Backend/Frontend functional requirements
├── PROJECT_TEAM_GUIDE.md              # Project overview in Russian
├── proposal/
│   ├── Project_Proposal_Framework.pdf # Approved 1-page Project Proposal
│   └── Progress_Report_W10.pdf        # Official Week 10 Progress Report (1-page PDF)
├── src_w6_w7/                         # Stage W6-W7: Architecture & Serial Baseline
│   ├── include/
│   │   ├── framework_types.h          # Data structures (TaskChunk, Heartbeat, Result)
│   │   └── sha256.h                   # FIPS 180-4 SHA-256 interface
│   └── src/
│       ├── sha256_serial.c            # Serial SHA-256 + NIST validation + Base-36 mapper
│       └── main_w6_w7.c               # Single-core baseline benchmark & task queue skeleton
├── src_w8_w9/                         # Stage W8-W9: OpenMP/SIMD + OpenCL GPU + Dynamic Scheduler
│   ├── kernels/
│   │   └── sha256_kernel.cl           # Universal OpenCL GPU kernel (Intel/Mac/AMD/NVIDIA)
│   ├── src/
│   │   └── main_w8_w9.c               # OpenMP+SIMD (with Anti-Choke CPU guard) & Dynamic Balancer
│   └── run_opencl_gpu_bench.py        # Direct OpenCL GPU execution & benchmark
└── src_w10/                           # Stage W10: Progress Report & Strong/Weak Scaling Suite
    ├── PROGRESS_REPORT_W10.md         # Full W10 Progress Report in Markdown
    ├── results_w10_scaling.csv        # Experimental CSV data (Strong & Weak scaling)
    ├── render_progress_report_w10.py  # PDF generator for Progress_Report_W10.pdf
    └── src/
        └── main_w10_scaling.c         # Automated Strong (1..8 threads) & Weak (1..4 nodes) suite
```

---

## Experimental Benchmarks (Intel Core i5-1135G7 + Intel Iris Xe GPU)

### 1. Strong Scaling & Hardware Acceleration (Hypothesis H1)

| Execution Mode | Hardware / Threads | Throughput (MH/s) | Speedup vs 1-Core | Parallel Eff. | Host CPU Load |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **W6–W7 Serial Baseline** | 1 CPU Thread | `2.38 MH/s` | `1.00x` | `100.00%` | 12.5% |
| **W8 OpenMP + SIMD** | 2 CPU Threads | `4.56 MH/s` | `1.91x` | `95.54%` | 25.0% |
| **W8 OpenMP + SIMD** | 4 CPU Threads | `7.69 MH/s` | `3.22x` | `80.60%` | 50.0% |
| **W8 OpenMP + SIMD (Anti-Choke)** | 6 CPU Threads (2 reserved) | `9.38 MH/s` | `3.94x` | `65.61%` | 75.0% |
| **W8 OpenMP + SIMD (Full CPU)** | 8 CPU Threads | `10.62 MH/s` | `4.46x` | `55.69%` | 100.0% |
| **W8 OpenCL GPU Offload** | **Intel(R) Iris(R) Xe (80 CUs)** | **`197.48 MH/s`** | **`85.10x`** | **GPU Offload** | **~2.0%** |

### 2. Weak Scaling & Dynamic Load Balancing (Hypothesis H3)
* **Weak Scaling (1M hashes/node across 1..4 Worker Nodes):** `100.00%` (1 node) $\rightarrow$ `98.23%` (2 nodes) $\rightarrow$ `96.53%` (3 nodes) $\rightarrow$ **`94.88%` (4 nodes, `44.07 MH/s`)**.
* **Dynamic Load Balancing Efficiency (24 chunks across 4 asymmetric nodes):** **`96.06%`** *(Target H3: `>90%`)*.

---

## How to Build & Run

**1. Stage W6–W7 (Serial Baseline & NIST Validation):**
```bash
cd src_w6_w7
gcc -O3 src/main_w6_w7.c src/sha256_serial.c -o build_w6_w7
./build_w6_w7
```

**2. Stage W8–W9 (OpenMP + SIMD & Dynamic Scheduler):**
```bash
cd src_w8_w9
gcc -O3 -fopenmp -mavx2 src/main_w8_w9.c ../src_w6_w7/src/sha256_serial.c -o build_w8_w9
./build_w8_w9
```

**3. Stage W8–W9 (Universal OpenCL GPU Benchmark):**
```bash
python src_w8_w9/run_opencl_gpu_bench.py
```

**4. Stage W10 (Strong & Weak Scaling Benchmark Suite):**
```bash
cd src_w10
gcc -O3 -fopenmp -mavx2 src/main_w10_scaling.c ../src_w6_w7/src/sha256_serial.c -o build_w10
./build_w10
```
