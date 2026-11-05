#include "../include/framework_types.h"
#include "../include/sha256.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ============================================================================
 * W6-W7 DELIVERABLE:
 * 1. Architecture Design & Task Queue Initialization (Module S1 - Atabek)
 * 2. Basic Network Skeleton (Module S2 - Begzhan)
 * 3. Serial SHA-256 Validation & Baseline Cracker (Module S5 - Madiyar)
 * ============================================================================ */

#define TOTAL_KEYSPACE  1679616ULL  /* 36^4 = 1,679,616 (4-char passwords aaaa..9999) */
#define CHUNK_SIZE      209952ULL   /* 8 chunks of 209,952 passwords each             */
#define PASS_LENGTH     4

/* Simulated Network Skeleton for W6-W7 before full MPI async loop in W8 */
static void network_skeleton_send_chunk(int dest_rank, const TaskChunk *chunk) {
    printf("  [NetSkeleton -> Rank %d] Sent TaskChunk #%u (range: %llu .. %llu)\n",
           dest_rank, chunk->chunk_id,
           (unsigned long long)chunk->start_index,
           (unsigned long long)chunk->end_index);
}

/* Serial Worker Execution (1 CPU Thread Baseline) */
static void execute_chunk_serial(const TaskChunk *chunk,
                                 const uint8_t target_hash[32],
                                 TaskResult *result) {
    char candidate[MAX_PASS_LEN];
    uint8_t candidate_hash[32];

    result->worker_rank = chunk->assigned_rank;
    result->chunk_id = chunk->chunk_id;
    result->found = 0;
    result->hashes_computed = 0;

    clock_t t0 = clock();

    for (uint64_t idx = chunk->start_index; idx < chunk->end_index; ++idx) {
        index_to_password(idx, PASS_LENGTH, candidate);
        sha256_compute((const uint8_t *)candidate, PASS_LENGTH, candidate_hash);
        result->hashes_computed++;

        if (memcmp(candidate_hash, target_hash, 32) == 0) {
            result->found = 1;
            result->matched_index = idx;
            strncpy(result->matched_password, candidate, MAX_PASS_LEN);
            break;
        }
    }

    clock_t t1 = clock();
    result->elapsed_sec = (double)(t1 - t0) / CLOCKS_PER_SEC;
}

int main(void) {
    printf("====================================================================\n");
    printf(" MINI-SPARK DISTRIBUTED ENGINE (STAGE W6-W7: ARCHITECTURE & SERIAL)\n");
    printf("====================================================================\n\n");

    /* Step 1: Validate SHA-256 implementation against NIST vectors (Module S5) */
    printf("[Step 1] Validating Cryptography Module (S5)...\n");
    if (!sha256_self_test()) {
        return 1;
    }

    /* Step 2: Generate a target forensic hash to crack (e.g., password "kz99") */
    const char *secret_password = "kz99";
    uint8_t target_hash[32];
    char target_hex[65];
    sha256_compute((const uint8_t *)secret_password, strlen(secret_password), target_hash);
    sha256_to_hex(target_hash, target_hex);
    printf("  Target Forensic Hash : %s\n", target_hex);
    printf("  Keyspace Size (36^4) : %llu combinations\n\n", (unsigned long long)TOTAL_KEYSPACE);

    /* Step 3: Initialize Master Task Queue (Module S1 - Scheduler) */
    uint32_t num_chunks = (uint32_t)((TOTAL_KEYSPACE + CHUNK_SIZE - 1) / CHUNK_SIZE);
    TaskChunk *queue = (TaskChunk *)calloc(num_chunks, sizeof(TaskChunk));

    printf("[Step 2] Initializing Master Task Queue (S1) -> %u chunks created:\n", num_chunks);
    for (uint32_t i = 0; i < num_chunks; ++i) {
        queue[i].chunk_id = i;
        queue[i].start_index = (uint64_t)i * CHUNK_SIZE;
        queue[i].end_index = queue[i].start_index + CHUNK_SIZE;
        if (queue[i].end_index > TOTAL_KEYSPACE) {
            queue[i].end_index = TOTAL_KEYSPACE;
        }
        queue[i].checkpoint_index = queue[i].start_index;
        queue[i].assigned_rank = (i % 4) + 1; /* Simulated Worker Ranks 1..4 */
        queue[i].status = CHUNK_PENDING;
    }

    /* Step 4: Dispatch chunks via Network Skeleton & Execute Serial Baseline */
    printf("\n[Step 3] Running Serial Baseline Execution across Task Chunks...\n");
    double total_time = 0.0;
    uint64_t total_hashes = 0;
    int password_cracked = 0;

    for (uint32_t i = 0; i < num_chunks; ++i) {
        queue[i].status = CHUNK_IN_FLIGHT;
        network_skeleton_send_chunk(queue[i].assigned_rank, &queue[i]);

        TaskResult res;
        execute_chunk_serial(&queue[i], target_hash, &res);

        total_time += res.elapsed_sec;
        total_hashes += res.hashes_computed;
        queue[i].status = CHUNK_COMPLETED;

        if (res.found) {
            printf("\n  >>> [SUCCESS] Worker Rank %d CRACKED PASSWORD in Chunk #%u! <<<\n",
                   res.worker_rank, res.chunk_id);
            printf("  >>> Recovered Password : '%s' (Index: %llu)\n",
                   res.matched_password, (unsigned long long)res.matched_index);
            password_cracked = 1;
            break;
        }
    }

    double throughput = (total_time > 0.0) ? (total_hashes / total_time) : 0.0;
    printf("\n====================================================================\n");
    printf(" W6-W7 BASELINE METRICS (Single-Core Serial Execution):\n");
    printf("   Total Hashes Computed : %llu\n", (unsigned long long)total_hashes);
    printf("   Total CPU Time        : %.4f seconds\n", total_time);
    printf("   Serial Throughput     : %.2f Hashes/sec (%.2f MH/s)\n",
           throughput, throughput / 1e6);
    printf("   Status                : %s\n", password_cracked ? "RECOVERED" : "NOT FOUND");
    printf("====================================================================\n");

    free(queue);
    return 0;
}
