# 📊 Week 10 Progress Report: Resilient Distributed Engine (`Mini-Spark`)

**Course:** Parallel & Distributed Computing (Instructor: Dr. Mohammed Alaa Ala'anzy)  
**Group Members:**  
* **Atabek Bakhytzhanov** (240107104) — *S1: Dynamic Scheduler & Load Balancer*  
* **Begzhan Imangali** (240107042) — *S2: Asynchronous MPI Network Engine*  
* **Karzhaubay Bakdaulet** (240107105) — *S3: Fault-Tolerance Daemon & Checkpointing*  
* **Yerkebulan Kenzhegali** (240107051) — *S4: Compute Accelerator (OpenMP SIMD + OpenCL GPU)*  
* **Madiyar Yerlanuly** (240107040) — *S5: Cryptographic Payload & Scaling Analytics*  

---

## 1. Completed Milestones (Weeks 6 – 10)

| Timeline | Milestone Description | Status | Deliverable / Code Path |
| :--- | :--- | :---: | :--- |
| **W6–W7** | Architecture contracts (`TaskChunk`, `HeartbeatPacket`), NIST FIPS 180-4 SHA-256 implementation & single-core baseline | ✅ **100% Done** | `src_w6_w7/src/main_w6_w7.c` |
| **W8** | Multi-core OpenMP + SIMD vectorization (`#pragma omp simd`) + Universal **OpenCL GPU Offloading** (`sha256_kernel.cl`) | ✅ **100% Done** | `src_w8_w9/kernels/sha256_kernel.cl` |
| **W9** | Dynamic Master-Worker Task Queue with adaptive chunk distribution across heterogeneous nodes | ✅ **100% Done** | `src_w8_w9/src/main_w8_w9.c` |
| **W10** | Strong & Weak Scaling Baseline Evaluation (without injected crashes) | ✅ **100% Done** | `src_w10/src/main_w10_scaling.c` |

---

## 2. Experimental Baseline Results (Measured on Intel Core i5-1135G7 + Intel Iris Xe GPU)

### 2.1 Strong Scaling & Hardware Acceleration (Hypothesis H1)
Workload: Fixed keyspace chunk of `2,000,000` SHA-256 hashes on CPU, and `10,000,000` hashes on GPU.

| Compute Backend | Threads / Cores | Time for 2M Hashes | Throughput (MH/s) | Speedup | Parallel Eff. | Host CPU Load |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Serial CPU (W6–W7)** | 1 Thread | `0.8389 s` | `2.38 MH/s` | `1.00x` | `100.00%` | `12.5%` |
| **OpenMP + SIMD** | 2 Threads | `0.4390 s` | `4.56 MH/s` | `1.91x` | `95.54%` | `25.0%` |
| **OpenMP + SIMD** | 4 Threads | `0.2602 s` | `7.69 MH/s` | `3.22x` | `80.60%` | `50.0%` |
| **OpenMP + SIMD (Anti-Choke)** | 6 Threads | `0.2131 s` | `9.38 MH/s` | `3.94x` | `65.61%` | `75.0%` |
| **OpenMP + SIMD (Full CPU)** | 8 Threads | `0.1883 s` | `10.62 MH/s` | `4.46x` | `55.69%` | `100.0%` |
| **OpenCL GPU Offload** | **80 GPU Compute Units** | **`0.0101 s`** *(equiv.)* | **`197.48 MH/s`** | **`85.10x`** | — | **`~2.0%`** |

> **Key Architectural Finding (Why we added OpenCL GPU Offloading):**  
> At 8 CPU threads (`100%` CPU utilization), parallel efficiency drops to `55.69%` due to SMT contention, and the OS experiences thread starvation that delays asynchronous MPI Heartbeats. By offloading SHA-256 hashing to the laptop's integrated **Intel(R) Iris(R) Xe Graphics (80 Compute Units)** via **OpenCL** (which works across Intel, Apple Silicon Mac, AMD, and NVIDIA), we achieve **`197.48 MH/s` (`85.1x` speedup)** while keeping the host CPU at **`~2%` load**, guaranteeing zero lag for MPI messaging and fault detection.

### 2.2 Weak Scaling & Dynamic Load Balancing (Hypothesis H3)
Workload: `1,000,000` SHA-256 hashes per Worker Node (scaling from `1M` on 1 node to `4M` on 4 nodes).

| Active Worker Nodes | Total Keyspace Evaluated | Wall-Clock Time (s) | Aggregate Cluster Throughput | Weak Scaling Efficiency |
| :---: | :---: | :---: | :---: | :---: |
| **1 Worker Node** | `1,000,000` | `0.0861 s` | `11.61 MH/s` | `100.00%` |
| **2 Worker Nodes** | `2,000,000` | `0.0877 s` | `22.82 MH/s` | `98.23%` |
| **3 Worker Nodes** | `3,000,000` | `0.0892 s` | `33.63 MH/s` | `96.53%` |
| **4 Worker Nodes** | `4,000,000` | `0.0908 s` | `44.07 MH/s` | **`94.88%`** *(Target H3: >90%)* |

* **Heterogeneous Load Balance Efficiency (W9 Test across 4 asymmetric laptops):** **`96.06%`**.

---

## 3. Roadmap for Remaining Weeks (W11 – W15)

* **Week 11 (Fault Tolerance — Hypothesis H2):** Enable the `Rescuer` daemon (`S3`) with `500ms` heartbeat timeouts, distributed checkpoint state recovery, and `Rank 1` Shadow Master failover.
* **Week 12 (Physical Cluster Integration):** Connect all 5 physical student laptops over WLAN MPI.
* **Week 13 (Chaos Testing):** Physically disconnect worker laptops mid-execution and measure recovery overhead (target `<15%` penalty).
* **Weeks 14–15:** Final report submission and live 5-laptop fault-tolerant demonstration.
