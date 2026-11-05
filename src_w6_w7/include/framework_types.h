#ifndef FRAMEWORK_TYPES_H
#define FRAMEWORK_TYPES_H

#include <stdint.h>

/* ============================================================================
 * W6-W7: ARCHITECTURE DESIGN (Mini-Spark Resilient Distributed Engine)
 * Defines the core data contracts between all 5 team modules (S1 - S5).
 * ============================================================================ */

#define MAX_PASS_LEN      16
#define SHA256_DIGEST_LEN 32
#define SHA256_HEX_LEN    65

/* Message Tags for MPI Asynchronous Engine (Module S2 - Begzhan) */
typedef enum {
    MSG_REQUEST_TASK = 10,  /* Worker -> Master: Ready for a new chunk        */
    MSG_ASSIGN_TASK  = 11,  /* Master -> Worker: Assigned password range      */
    MSG_HEARTBEAT    = 12,  /* Worker -> Master: Alive + current progress     */
    MSG_TASK_RESULT  = 13,  /* Worker -> Master: Chunk finished or Hash found */
    MSG_TERMINATE    = 99   /* Master -> Worker: Shutdown cleanly             */
} MessageTag;

/* Chunk state in Master Queue (Module S1 - Atabek & Module S3 - Karzhaubay) */
typedef enum {
    CHUNK_PENDING    = 0,
    CHUNK_IN_FLIGHT  = 1,
    CHUNK_COMPLETED  = 2,
    CHUNK_RECOVERING = 3    /* Re-queued after worker heartbeat timeout */
} ChunkStatus;

/* Task Chunk descriptor (sent between Master and Workers) */
typedef struct {
    uint32_t chunk_id;
    uint64_t start_index;       /* Starting password index in keyspace        */
    uint64_t end_index;         /* Ending password index (exclusive)          */
    uint64_t checkpoint_index;  /* Last verified progress (Module S3)         */
    int      assigned_rank;     /* MPI Rank currently working on this chunk   */
    int      status;            /* ChunkStatus                                */
} TaskChunk;

/* Worker Heartbeat & Checkpoint packet (Module S2 & Module S3) */
typedef struct {
    int      worker_rank;
    uint32_t chunk_id;
    uint64_t current_index;     /* Checkpoint progress inside the chunk       */
    double   hashes_per_sec;    /* Current local throughput (CPU/GPU)         */
} HeartbeatPacket;

/* Result packet returned when a chunk completes or password is cracked */
typedef struct {
    int      worker_rank;
    uint32_t chunk_id;
    int      found;             /* 1 if target hash matched, 0 otherwise      */
    uint64_t matched_index;
    char     matched_password[MAX_PASS_LEN];
    double   elapsed_sec;
    uint64_t hashes_computed;
} TaskResult;

#endif /* FRAMEWORK_TYPES_H */
