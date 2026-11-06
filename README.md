#  Distributed Computing Engine: A Resilient Mini-Framework for Cryptographic Forensics

**Course:** Parallel & Distributed Computing (Instructor: Dr. Mohammed Alaa Ala'anzy)  
**Project Architecture:** Mini-Spark C/C++ Resilient Engine (MPI + OpenMP SIMD + Universal OpenCL GPU Offloading)

---

##  Team Members & Modules

| Role | Student Name | ID | Module Responsibility |
| :--- | :--- | :--- | :--- |
| **S1 (The Scheduler)** | **Atabek Bakhytzhanov** | `240107104` | Master task queue, keyspace partitioning, Dynamic Load Balancing (H3) |
| **S2 (The Networker)** | **Begzhan Imangali** | `240107042` | Asynchronous MPI messaging (`MPI_Isend`/`MPI_Irecv`) & Heartbeat protocol |
| **S3 (The Rescuer)** | **Karzhaubay Bakdaulet** | `240107105` | Fault-tolerance daemon, Checkpointing, Crash recovery (H2) & Shadow Master |
| **S4 (The Accelerator)** | **Yerkebulan Kenzhegali** | `240107051` | Universal GPU Offloading (**OpenCL**) + Multi-core CPU (**OpenMP + SIMD**) (H1) |
| **S5 (Data Sci & Crypto)** | **Madiyar Yerlanuly** | `240107040` | NIST SHA-256 payload, forensic verification, performance & scaling analytics |

 **Полный гайд для команды (на русском):** [PROJECT_TEAM_GUIDE.md](./PROJECT_TEAM_GUIDE.md)  
 **Approved Project Proposal (PDF):** [proposal/Project_Proposal_Framework.pdf](./proposal/Project_Proposal_Framework.pdf)  
 **Week 10 Progress Report (PDF):** [proposal/Progress_Report_W10.pdf](./proposal/Progress_Report_W10.pdf) | [Markdown](./src_w10/PROGRESS_REPORT_W10.md)

---

##  Repository Structure (Week-by-Week Progress: W6 – W10)

```text
project_pdc-/
├── README.md                          # Project overview, benchmarks & build instructions
├── PROJECT_TEAM_GUIDE.md              # Detailed Russian guide for all 5 team members
├── proposal/
│   ├── Project_Proposal_Framework.pdf # Approved 1-page Project Proposal
│   └── Progress_Report_W10.pdf        # Official Week 10 Progress Report (1-page PDF)
├── src_w6_w7/                         # Stage W6-W7: Architecture & Serial Baseline
│   ├── include/
│   │   ├── framework_types.h          # Data structures (TaskChunk, Heartbeat, Result)
│   │   └── sha256.h                   # FIPS 180-4 SHA-256 interface
│   └── src/
│       ├── sha256_serial.c            # Serial SHA-256 + NIST validation + keyspace mapper
│       └── main_w6_w7.c               # Single-core baseline benchmark & task queue skeleton
├── src_w8_w9/                         # Stage W8-W9: OpenMP/SIMD + OpenCL GPU + Dynamic Scheduler
│   ├── kernels/
│   │   └── sha256_kernel.cl           # Universal OpenCL GPU kernel (Intel/Mac/AMD/NVIDIA)
│   ├── src/
│   │   └── main_w8_w9.c               # OpenMP+SIMD (with Anti-Choke CPU guard) & Dynamic Balancer
│   └── run_opencl_gpu_bench.py        # Zero-dependency OpenCL GPU runner & benchmark
└── src_w10/                           # Stage W10: Progress Report & Strong/Weak Scaling Suite
    ├── PROGRESS_REPORT_W10.md         # Full W10 Progress Report in Markdown
    ├── results_w10_scaling.csv        # Experimental CSV data (Strong & Weak scaling)
    ├── render_progress_report_w10.py  # PDF generator for Progress_Report_W10.pdf
    └── src/
        └── main_w10_scaling.c         # Automated Strong (1..8 threads) & Weak (1..4 nodes) suite
```

---

##  Experimental Benchmarks (Measured on Intel Core i5-1135G7 + Intel Iris Xe GPU)

### 1. Strong Scaling & Hardware Acceleration (Hypothesis H1)
To prevent **CPU starvation** (which delays MPI Heartbeats and freezes laptop OS threads), our engine reserves 2 CPU threads for networking/OS and offloads heavy SHA-256 brute-forcing to **any available GPU via OpenCL**:

| Execution Mode | Hardware / Threads | Throughput (MH/s) | Speedup vs 1-Core | Parallel Eff. | Host CPU Load |
| :--- | :--- | :---: | :---: | :---: | :---: |
| **W6–W7 Serial Baseline** | 1 CPU Thread | `2.38 MH/s` | `1.00x` | `100.00%` | 12.5% |
| **W8 OpenMP + SIMD** | 2 CPU Threads | `4.56 MH/s` | `1.91x` | `95.54%` | 25.0% |
| **W8 OpenMP + SIMD** | 4 CPU Threads | `7.69 MH/s` | `3.22x` | `80.60%` | 50.0% |
| **W8 OpenMP + SIMD (Anti-Choke)** | 6 CPU Threads (2 reserved) | `9.38 MH/s` | `3.94x` | `65.61%` | 75.0% |
| **W8 OpenMP + SIMD (Full CPU)** | 8 CPU Threads | `10.62 MH/s` | `4.46x` | `55.69%` | 100.0% |
| **W8 OpenCL GPU Offload** | **Intel(R) Iris(R) Xe (80 CUs)** | **`197.48 MH/s`** | **`85.10x`** | **GPU Offload** | **~2.0%** |

### 2. Weak Scaling & Dynamic Load Balancing (Hypothesis H3)
* **Weak Scaling (1M hashes/node across 1..4 Worker Nodes):** `100.00%` (1 node) -> `98.23%` (2 nodes) -> `96.53%` (3 nodes) -> **`94.88%` (4 nodes, `44.07 MH/s`)**.
* **Dynamic Load Balancing Efficiency (24 chunks across 4 asymmetric laptops):** **`96.06%`** *(surpassing the `>90%` target in Hypothesis H3)*.

---

##  How to Build & Run

### 1. Run Stage W6–W7 (Serial Baseline & NIST Validation)
```bash
cd src_w6_w7
gcc -O3 src/main_w6_w7.c src/sha256_serial.c -o build_w6_w7
./build_w6_w7
```

### 2. Run Stage W8–W9 (OpenMP + SIMD & Dynamic Scheduler)
```bash
cd src_w8_w9
gcc -O3 -fopenmp -mavx2 src/main_w8_w9.c ../src_w6_w7/src/sha256_serial.c -o build_w8_w9
./build_w8_w9
```

### 3. Run Stage W8–W9 Universal OpenCL GPU Benchmark (Windows / Intel / AMD / NVIDIA)
```bash
python src_w8_w9/run_opencl_gpu_bench.py
```

### 4. Run Stage W10 Strong & Weak Scaling Suite (Progress Report Data)
```bash
cd src_w10
gcc -O3 -fopenmp -mavx2 src/main_w10_scaling.c ../src_w6_w7/src/sha256_serial.c -o build_w10
./build_w10
```
