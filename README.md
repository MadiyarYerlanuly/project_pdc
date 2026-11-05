# 🚀 Distributed Computing Engine: A Resilient Mini-Framework for Cryptographic Forensics

**Course:** Parallel & Distributed Computing (Instructor: Dr. Mohammed Alaa Ala'anzy)  
**Project Architecture:** Mini-Spark C/C++ Resilient Engine (MPI + OpenMP SIMD + Universal OpenCL GPU Offloading)

---

## 👥 Team Members & Modules

| Role | Student Name | ID | Module Responsibility |
| :--- | :--- | :--- | :--- |
| **S1 (The Scheduler)** | **Atabek Bakhytzhanov** | `240107104` | Master task queue, keyspace partitioning, Dynamic Load Balancing (H3) |
| **S2 (The Networker)** | **Begzhan Imangali** | `240107042` | Asynchronous MPI messaging (`MPI_Isend`/`MPI_Irecv`) & Heartbeat protocol |
| **S3 (The Rescuer)** | **Karzhaubay Bakdaulet** | `240107105` | Fault-tolerance daemon, Checkpointing, Crash recovery (H2) & Shadow Master |
| **S4 (The Accelerator)** | **Yerkebulan Kenzhegali** | `240107051` | Universal GPU Offloading (**OpenCL**) + Multi-core CPU (**OpenMP + SIMD**) (H1) |
| **S5 (Data Sci & Crypto)** | **Madiyar Yerlanuly** | `240107040` | NIST SHA-256 payload, forensic verification, performance & scaling analytics |

📄 **Полный гайд для команды (на русском):** [PROJECT_TEAM_GUIDE.md](./PROJECT_TEAM_GUIDE.md)  
📄 **Approved Project Proposal (PDF):** [proposal/Project_Proposal_Framework.pdf](./proposal/Project_Proposal_Framework.pdf)

---

## 📂 Repository Structure (Week-by-Week Progress)

```text
project_pdc-/
├── README.md                          # Project overview, benchmarks & build instructions
├── PROJECT_TEAM_GUIDE.md              # Detailed Russian guide for all 5 team members
├── proposal/
│   └── Project_Proposal_Framework.pdf # Approved 1-page Project Proposal
├── src_w6_w7/                         # Stage W6-W7: Architecture & Serial Baseline
│   ├── include/
│   │   ├── framework_types.h          # Data structures (TaskChunk, Heartbeat, Result)
│   │   └── sha256.h                   # FIPS 180-4 SHA-256 interface
│   └── src/
│       ├── sha256_serial.c            # Serial SHA-256 + NIST validation + keyspace mapper
│       └── main_w6_w7.c               # Single-core baseline benchmark & task queue skeleton
└── src_w8_w9/                         # Stage W8-W9: OpenMP/SIMD + OpenCL GPU + Dynamic Scheduler
    ├── kernels/
    │   └── sha256_kernel.cl           # Universal OpenCL GPU kernel (Intel/Mac/AMD/NVIDIA)
    ├── src/
    │   └── main_w8_w9.c               # OpenMP+SIMD (with Anti-Choke CPU guard) & Dynamic Balancer
    └── run_opencl_gpu_bench.py        # Zero-dependency OpenCL GPU runner & benchmark
```

---

## 📊 Experimental Benchmarks (Measured on Intel Core i5-1135G7 + Intel Iris Xe GPU)

### 1. Compute Acceleration (Hypothesis H1)
To prevent **CPU starvation** (which delays MPI Heartbeats and freezes laptop OS threads), our engine reserves 2 CPU threads for networking/OS and offloads heavy SHA-256 brute-forcing to **any available GPU via OpenCL**:

| Execution Mode | Hardware Used | Throughput (MH/s) | Speedup vs 1-Core | Host CPU Load |
| :--- | :--- | :---: | :---: | :---: |
| **W6–W7 Serial Baseline** | 1 CPU Thread (Intel i5-1135G7) | `2.32 – 2.43 MH/s` | `1.00x` | 12.5% |
| **W8 OpenMP + SIMD** | 6 CPU Threads (2 reserved for MPI) | `10.07 MH/s` | **`4.15x`** | 75.0% |
| **W8 OpenCL GPU Offload** | **Intel(R) Iris(R) Xe (80 Compute Units)** | **`197.48 MH/s`** | **`85.10x`** | **~2.0%** |

### 2. Dynamic Load Balancing Across Heterogeneous Nodes (Hypothesis H3)
Tested with 24 chunks (`3,359,232` hashes) across 4 asymmetric node profiles:
* **Dynamic Load Balancing Efficiency:** **`96.06%`** *(surpassing the `>90%` target in Hypothesis H3)*.

---

## 🛠️ How to Build & Run

### 1. Run Stage W6–W7 (Serial Baseline & NIST Validation)
Using GCC (Linux / WSL / macOS / MinGW):
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
