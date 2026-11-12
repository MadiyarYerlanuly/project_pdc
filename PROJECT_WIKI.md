# Project Technical Wiki (`Mini-Spark`)

## 1. Project Concept & Goal

We are building **Mini-Spark**: a fault-tolerant distributed computing engine designed to run across a cluster of heterogeneous laptops over a local network.

Our benchmark application is **Distributed Cryptographic Forensics (SHA-256 Recovery)**. Instead of using a single computer to brute-force a SHA-256 digital signature (which takes too long), the system unites up to 5 laptops into a coordinated cluster. The goal of the project is not just to recover the password, but to prove that our custom distributed architecture can dynamically balance workloads across different hardware and survive unexpected node crashes without stopping the computation.

---

## 2. Core Scientific Requirements (Hypotheses H1, H2, H3)

Everything in our project revolves around three core requirements from the approved proposal:

* **H1 — Hardware-Agnostic Acceleration & Anti-Choke Protection:**
  If a laptop's CPU is loaded at 100% with hashing, the operating system freezes and network messages lag. To solve this, our engine uses two mechanisms:
  1. **Universal GPU Offloading (OpenCL):** Heavy SHA-256 math is offloaded to the laptop's GPU (works on Intel integrated graphics, Apple Silicon M-series, AMD, and NVIDIA). This delivers massive throughput while keeping host CPU usage around 2%.
  2. **Anti-Choke OpenMP CPU Mode:** When computing on the CPU (via OpenMP and SIMD vectorization), the engine intentionally leaves 2 logical CPU threads free so the OS and network layer never starve.
* **H2 — Fault Tolerance (Heartbeats, Checkpointing, and Shadow Master):**
  Standard MPI programs crash completely if even one laptop disconnects. Our engine prevents this on two levels:
  1. **Worker Recovery:** Active workers send a heartbeat signal every 500ms along with their current progress (checkpoint). If a worker stops responding (timeout > 1000ms), the Master marks it as offline, takes the dead worker's last saved checkpoint, and reassigns only the remaining uncomputed portion of that task to a healthy worker.
  2. **Master Failover (Shadow Master):** To avoid a Single Point of Failure, one worker node also acts as a Shadow Master (backup). It receives state updates from the primary Master and takes over orchestration if the primary Master goes offline.
* **H3 — Dynamic Load Balancing:**
  Since our laptops have very different CPU/GPU speeds, we cannot split the work equally at the start. Instead, the Master slices the total password space into small chunks and keeps them in a dynamic queue. Whenever a worker finishes a chunk, it requests the next one. Faster laptops automatically process more chunks, ensuring no node sits idle and maintaining over 90% cluster efficiency.

---

## 3. How the Engine Works Under the Hood

### 3.1 Keyspace Generation (No Dictionary Files)
The system does not store or transfer text files with passwords over the network. We use a 36-character alphabet (lowercase letters `a–z` and digits `0–9`).
For a given password length $L$, the total number of combinations is $36^L$ (for example, $36^4 = 1,679,616$ combinations; $36^5 = 60,466,176$ combinations).
Every number from $0$ to $36^L - 1$ corresponds to one unique password via Base-36 math. Therefore, the Master never sends text strings over Wi-Fi—it only sends two numbers to a Worker: the starting index and the ending index of a chunk. The Worker converts each index into a candidate password on the fly in memory, hashes it with SHA-256, and compares it against the target hash.

### 3.2 Task Chunk Lifecycle
Each chunk in the Master queue passes through four logical states:
* **Pending:** Waiting in the Master queue to be picked up by a free worker.
* **In-Flight:** Currently being processed by an assigned worker node.
* **Recovering:** The assigned worker disconnected or crashed; the chunk is rolled back to its last reported checkpoint index and prioritized for reassignment.
* **Completed:** Fully scanned by a worker (either no match was found in that range, or the target password was successfully recovered).

### 3.3 Repository Structure Overview
* **src_w6_w7:** Contains the core C data structures, the standard SHA-256 implementation, Base-36 index-to-password mapping logic, and the single-core serial baseline.
* **src_w8_w9:** Contains the multi-core OpenMP + SIMD execution logic (with the Anti-Choke thread limiter), the dynamic load-balancing scheduler, and the universal OpenCL GPU kernel and runner.
* **src_w10:** Contains the automated Strong Scaling (1 to 8 threads) and Weak Scaling (1 to 4 nodes) benchmark suite and the exported CSV metrics.

### 3.4 Network & Local Hardware Execution Model (Why It Runs on a Local Port)
Because a browser tab is sandboxed and a cloud-hosted server (like Vercel or Render) cannot access the physical CPU cores or GPUs of our 5 laptops, the system **must run locally on our machines over a shared Wi-Fi / LAN network**:
1. **Local Backend Server on the Master Laptop:** The web server and backend run on a local port of the Master laptop (bound to `0.0.0.0:PORT`, e.g., `http://localhost:8000` locally, and accessible to the other 4 laptops via the Master's Wi-Fi IP such as `http://192.168.x.x:8000`).
2. **Direct Hardware Access on Each Node:** Running the backend/worker process natively on each laptop allows the OS to directly invoke our compiled C binaries (to control CPU cores via OpenMP + SIMD) and the system's OpenCL driver (to offload SHA-256 hashing onto the laptop's integrated or discrete GPU).
3. **Multi-Laptop Wi-Fi Communication:** All 5 laptops connect to the same Wi-Fi hotspot. Worker laptops connect to the Master's local IP and port to register their hardware capabilities, pull chunk ranges (`start_index` to `end_index`), execute the C / OpenCL computation on their own local CPU/GPU, and send back 500ms heartbeats and results with ultra-low local network latency.

---

## 4. Functional Requirements for Backend & Frontend

The Web Application is our control center and visualization layer for the cluster. The design, layout, and tech stack are completely up to the web team, as long as the following functional capabilities are supported on the Backend and Frontend.

### 4.1 What the Backend Needs to Handle
1. **Target & Job Initialization:**
   * Accept an uploaded file/archive (to extract or compute its SHA-256 hash) or accept a raw 64-character SHA-256 hex string directly.
   * Configure the search parameters: password length ($L$) and chunk size (how many indices per chunk).
   * Generate the initial queue of chunks covering the keyspace range $[0, 36^L)$.
2. **Cluster & Node Coordination:**
   * Maintain the list of connected nodes (up to 5 laptops) with their roles (Master, Shadow Master, Worker) and hardware execution mode (OpenCL GPU vs. OpenMP SIMD CPU, plus allowed CPU thread count).
   * Dispatch pending or recovering chunks to available workers and collect completion results.
   * Bridge with our existing C / OpenCL execution modules (or run worker processes) to perform the actual hashing and return real throughput metrics.
3. **Heartbeat Monitoring & Checkpoint State:**
   * Track periodic heartbeat updates from active workers (current index processed, local speed in MH/s, and CPU load).
   * Detect heartbeat timeouts when a node disconnects or crashes, update the interrupted chunk's starting point to its last checkpoint index, and put it back into the queue for another worker.
   * Support a fault-injection trigger (simulating a worker crash or Master failover on demand) so we can demonstrate fault tolerance live during the presentation.

### 4.2 What the Frontend Needs to Provide
1. **Job Input & Configuration:**
   * Ability to select/upload a target file or input a target SHA-256 hash.
   * Controls to choose the password length, chunk size, and start/stop/reset the distributed computation.
2. **Cluster & Node Management:**
   * Ability to add/configure nodes in the cluster, assign their roles (Master, Shadow Master, Worker), and select whether each node computes on its GPU (OpenCL) or CPU (OpenMP with Anti-Choke thread limit).
   * Display the live status of each connected computer: online/offline state, heartbeat latency, current assigned chunk, local progress, and hashing speed (MH/s).
3. **Fault Tolerance Controls & Visibility:**
   * An interactive way to trigger/simulate a node failure (disconnecting a Worker or killing the Master) during an active run.
   * Visibility into the recovery process: showing that a dead node's unfinished chunk was restored from its last checkpoint and picked up by a surviving node, as well as showing Shadow Master promotion if the primary Master fails.
4. **Overall Progress & Final Result:**
   * Live cluster-wide metrics: total combined throughput (MH/s), overall percentage of keyspace scanned, chunk completion status, and load-balancing efficiency.
   * Clear notification when the password is recovered: displaying the cracked password string, its numeric index, which worker node found it, and the total execution time.
   * Ability to display or reference our scaling benchmark results (comparing 1-core Serial vs. OpenMP SIMD vs. OpenCL GPU, and Weak/Strong scaling across nodes).
