#include "../../src_w6_w7/include/framework_types.h"
#include "../../src_w6_w7/include/sha256.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <omp.h>

/* ============================================================================
 * STAGE W8-W9:
 * - Module S4 (Yerkebulan): OpenMP + SIMD Vectorized Accelerator (Hypothesis H1)
 *   with CPU Headroom Reservation so the OS & MPI Heartbeats never choke!
 * - Module S2 (Begzhan): Asynchronous Non-Blocking MPI Messaging Engine
 * - Module S1 (Atabek): Dynamic Master-Worker Load Balancer (Hypothesis H3)
 * ============================================================================ */

#define TOTAL_KEYSPACE  3359232ULL  /* 2 x 36^4 passwords for W8-W9 scaling benchmark */
#define BASE_CHUNK_SIZE 139968ULL   /* 24 dynamic chunks in the Master Queue          */
#define PASS_LENGTH     4

/* ----------------------------------------------------------------------------
 * MODULE S4: OpenMP + SIMD Multi-Core Engine with Anti-Choke Thread Limiter
 * ---------------------------------------------------------------------------- */
static void execute_chunk_omp_simd(const TaskChunk *chunk,
                                   const uint8_t target_hash[32],
                                   int max_worker_threads,
                                   TaskResult *result) {
    result->worker_rank = chunk->assigned_rank;
    result->chunk_id = chunk->chunk_id;
    result->found = 0;
    result->matched_index = 0;
    result->hashes_computed = chunk->end_index - chunk->start_index;

    volatile int shared_found = 0;
    uint64_t found_idx = 0;
    char found_pass[MAX_PASS_LEN] = {0};

    double t0 = omp_get_wtime();

    /* Reserve CPU headroom so MPI Heartbeats & OS threads never starve */
    #pragma omp parallel num_threads(max_worker_threads)
    {
        char local_pass[MAX_PASS_LEN];
        uint8_t local_hash[32];

        #pragma omp for schedule(dynamic, 4096)
        for (uint64_t idx = chunk->start_index; idx < chunk->end_index; ++idx) {
            if (shared_found) continue;

            index_to_password(idx, PASS_LENGTH, local_pass);
            sha256_compute((const uint8_t *)local_pass, PASS_LENGTH, local_hash);

            /* SIMD-assisted 32-byte digest comparison */
            int diff = 0;
            #pragma omp simd reduction(|:diff)
            for (int b = 0; b < 32; ++b) {
                diff |= (local_hash[b] ^ target_hash[b]);
            }

            if (diff == 0) {
                #pragma omp critical
                {
                    shared_found = 1;
                    found_idx = idx;
                    strncpy(found_pass, local_pass, MAX_PASS_LEN);
                }
            }
        }
    }

    double t1 = omp_get_wtime();
    result->elapsed_sec = t1 - t0;
    if (shared_found) {
        result->found = 1;
        result->matched_index = found_idx;
        strncpy(result->matched_password, found_pass, MAX_PASS_LEN);
    }
}

/* ----------------------------------------------------------------------------
 * MODULE S2: Asynchronous Non-Blocking Message Envelope (Models MPI_Isend/Irecv)
 * ---------------------------------------------------------------------------- */
typedef struct {
    int        active;
    MessageTag tag;
    int        src_rank;
    int        dest_rank;
    TaskChunk  chunk_payload;
    TaskResult result_payload;
} AsyncMpiRequest;

/* ----------------------------------------------------------------------------
 * MODULE S1: Dynamic Load Balancer for Heterogeneous Nodes (Hypothesis H3)
 * ---------------------------------------------------------------------------- */
typedef struct {
    int         rank;
    const char *node_name;
    double      relative_speed; /* Simulates heterogeneous laptop speeds */
    int         chunks_completed;
    uint64_t    total_hashes;
    double      busy_time_sec;
} WorkerProfile;

int main(void) {
    printf("======================================================================\n");
    printf(" MINI-SPARK ENGINE (STAGE W8-W9: OPENMP/SIMD + ASYNC MPI + SCHEDULER)\n");
    printf("======================================================================\n\n");

    int total_cpu_threads = omp_get_max_threads();
    /* Leave at least 2 threads free for OS + MPI Heartbeats so laptop never chokes */
    int safe_compute_threads = (total_cpu_threads > 2) ? (total_cpu_threads - 2) : total_cpu_threads;

    printf("[Hardware Check] Detected %d logical CPU threads on this laptop.\n", total_cpu_threads);
    printf("[Anti-Choke Guard] Reserving 2 threads for MPI/OS; using %d threads for OpenMP.\n\n",
           safe_compute_threads);

    /* Target password near the end of the keyspace so all chunks get tested */
    const char *secret_password = "99zz";
    uint8_t target_hash[32];
    char target_hex[65];
    sha256_compute((const uint8_t *)secret_password, strlen(secret_password), target_hash);
    sha256_to_hex(target_hash, target_hex);

    /* Step 1: Benchmark W8 Hypothesis H1 (Serial 1-Core vs OpenMP+SIMD) */
    printf("[W8 Benchmark - Hypothesis H1] Comparing Serial vs OpenMP+SIMD...\n");
    TaskChunk bench_chunk = {0, 0, 1000000ULL, 0, 1, CHUNK_IN_FLIGHT};
    TaskResult serial_res, omp_res;

    execute_chunk_omp_simd(&bench_chunk, target_hash, 1, &serial_res);
    execute_chunk_omp_simd(&bench_chunk, target_hash, safe_compute_threads, &omp_res);

    double serial_mhs = (1000000.0 / serial_res.elapsed_sec) / 1e6;
    double omp_mhs    = (1000000.0 / omp_res.elapsed_sec) / 1e6;
    double speedup_h1 = omp_mhs / serial_mhs;

    printf("  -> 1-Core Serial Speed      : %.2f MH/s (%.4f s for 1M hashes)\n",
           serial_mhs, serial_res.elapsed_sec);
    printf("  -> OpenMP+SIMD (%d threads) : %.2f MH/s (%.4f s for 1M hashes)\n",
           safe_compute_threads, omp_mhs, omp_res.elapsed_sec);
    printf("  -> CPU Speedup Achieved     : %.2fx faster (with 2 threads still free for MPI!)\n\n",
           speedup_h1);

    /* Step 2: W9 Dynamic Master-Worker Load Balancing across 4 Asymmetric Workers */
    printf("[W9 Benchmark - Hypothesis H3] Dynamic Load Balancing on Heterogeneous Cluster:\n");
    WorkerProfile workers[4] = {
        {1, "Node 1 (Lenovo Intel Iris Xe OpenCL)", 3.2, 0, 0, 0.0},
        {2, "Node 2 (MacBook Apple M2 GPU OpenCL)", 4.0, 0, 0, 0.0},
        {3, "Node 3 (Gaming Laptop GPU OpenCL)   ", 5.5, 0, 0, 0.0},
        {4, "Node 4 (Older Laptop CPU OpenMP)    ", 1.0, 0, 0, 0.0}
    };

    uint32_t num_chunks = (uint32_t)((TOTAL_KEYSPACE + BASE_CHUNK_SIZE - 1) / BASE_CHUNK_SIZE);
    TaskChunk *queue = (TaskChunk *)calloc(num_chunks, sizeof(TaskChunk));
    for (uint32_t i = 0; i < num_chunks; ++i) {
        queue[i].chunk_id = i;
        queue[i].start_index = (uint64_t)i * BASE_CHUNK_SIZE;
        queue[i].end_index = queue[i].start_index + BASE_CHUNK_SIZE;
        if (queue[i].end_index > TOTAL_KEYSPACE) queue[i].end_index = TOTAL_KEYSPACE;
        queue[i].status = CHUNK_PENDING;
    }

    /* Dynamic scheduling simulation: always assign next pending chunk to whichever
     * worker finishes earliest (asynchronous MPI_Isend / MPI_Irecv pull model) */
    for (uint32_t i = 0; i < num_chunks; ++i) {
        /* Find worker that becomes free first */
        int best_w = 0;
        for (int w = 1; w < 4; ++w) {
            if (workers[w].busy_time_sec < workers[best_w].busy_time_sec) {
                best_w = w;
            }
        }

        queue[i].assigned_rank = workers[best_w].rank;
        queue[i].status = CHUNK_IN_FLIGHT;

        TaskResult res;
        execute_chunk_omp_simd(&queue[i], target_hash, safe_compute_threads, &res);

        /* Scale time by worker's hardware profile to evaluate dynamic balancer */
        double simulated_node_time = res.elapsed_sec / workers[best_w].relative_speed;
        workers[best_w].busy_time_sec += simulated_node_time;
        workers[best_w].chunks_completed++;
        workers[best_w].total_hashes += res.hashes_computed;
        queue[i].status = CHUNK_COMPLETED;
    }

    double max_finish = 0.0, min_finish = 1e9, sum_finish = 0.0;
    for (int w = 0; w < 4; ++w) {
        if (workers[w].busy_time_sec > max_finish) max_finish = workers[w].busy_time_sec;
        if (workers[w].busy_time_sec < min_finish) min_finish = workers[w].busy_time_sec;
        sum_finish += workers[w].busy_time_sec;
        printf("  [Rank %d] %s -> Completed %2d chunks (%7llu hashes) in %.4fs\n",
               workers[w].rank, workers[w].node_name,
               workers[w].chunks_completed,
               (unsigned long long)workers[w].total_hashes,
               workers[w].busy_time_sec);
    }

    double load_balance_efficiency = ((sum_finish / 4.0) / max_finish) * 100.0;
    printf("\n======================================================================\n");
    printf(" W8-W9 SUMMARY METRICS (Ready for Progress Report):\n");
    printf("   Total Chunks Scheduled Dynamically : %u chunks\n", num_chunks);
    printf("   Dynamic Load Balancing Efficiency  : %.2f%% (Target H3: >90%%)\n",
           load_balance_efficiency);
    printf("======================================================================\n");

    free(queue);
    return 0;
}
