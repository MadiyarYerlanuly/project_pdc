/* ============================================================================
 * Mini-Spark — CPU range engine used by cluster/worker.py (Module S4, H1)
 *
 *   ms_cpu_engine <target_sha256_hex> <start_index> <end_index> <pass_len> <threads>
 *
 * Scans keyspace indices [start, end) with <threads> POSIX threads.
 * The worker passes threads = logical cores − 2 when Anti-Choke is on, so the OS
 * and the heartbeat thread never starve (same idea as main_w8_w9.c, but with
 * pthreads so it builds with Apple clang, which ships without OpenMP).
 *
 * stdout protocol (one line each, flushed):
 *   P <hashes_done>        progress, every ~200 ms
 *   F <matched_index>      password found (process exits 0)
 *   D <hashes_done>        range finished, no match
 *
 * Candidate generation = index_to_password() from src_w6_w7/src/sha256_serial.c
 * (CHARSET a–z0–9, most significant char first). SHA-256 is a single-block
 * FIPS 180-4 compression, the same math as kernels/sha256_kernel.cl.
 * ============================================================================ */
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <pthread.h>
#include <time.h>

#define BLOCK 65536ULL

static const char CHARSET[] = "abcdefghijklmnopqrstuvwxyz0123456789";
static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static uint32_t target[8];
static uint64_t g_start, g_end;
static int g_len;
static _Atomic uint64_t next_block = 0;
static _Atomic uint64_t done = 0;
static _Atomic int found = 0;
static _Atomic uint64_t found_idx = 0;

static int match(const char *pw, int len) {
    uint8_t block[64] = {0};
    memcpy(block, pw, (size_t)len);
    block[len] = 0x80;
    uint32_t bits = (uint32_t)len * 8;
    block[62] = (uint8_t)(bits >> 8);
    block[63] = (uint8_t)bits;
    uint32_t w[64];
    for (int i = 0; i < 16; i++)
        w[i] = ((uint32_t)block[i * 4] << 24) | ((uint32_t)block[i * 4 + 1] << 16) | ((uint32_t)block[i * 4 + 2] << 8) | block[i * 4 + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROTR(w[i - 15], 7) ^ ROTR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROTR(w[i - 2], 17) ^ ROTR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = 0x6a09e667, b = 0xbb67ae85, c = 0x3c6ef372, d = 0xa54ff53a;
    uint32_t e = 0x510e527f, f = 0x9b05688c, g = 0x1f83d9ab, h = 0x5be0cd19;
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = h + (ROTR(e, 6) ^ ROTR(e, 11) ^ ROTR(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
        uint32_t t2 = (ROTR(a, 2) ^ ROTR(a, 13) ^ ROTR(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    return a + 0x6a09e667 == target[0] && b + 0xbb67ae85 == target[1] && c + 0x3c6ef372 == target[2] &&
           d + 0xa54ff53a == target[3] && e + 0x510e527f == target[4] && f + 0x9b05688c == target[5] &&
           g + 0x1f83d9ab == target[6] && h + 0x5be0cd19 == target[7];
}

static void index_to_password(uint64_t index, int len, char *out) {
    for (int pos = len - 1; pos >= 0; --pos) {
        out[pos] = CHARSET[index % 36];
        index /= 36;
    }
    out[len] = '\0';
}

static void *worker(void *arg) {
    (void)arg;
    char pw[24];
    for (;;) {
        if (atomic_load(&found)) break;
        uint64_t blk = atomic_fetch_add(&next_block, 1);
        uint64_t s = g_start + blk * BLOCK;
        if (s >= g_end) break;
        uint64_t e = s + BLOCK < g_end ? s + BLOCK : g_end;
        index_to_password(s, g_len, pw);
        for (uint64_t idx = s; idx < e; idx++) {
            if (match(pw, g_len)) {
                atomic_store(&found_idx, idx);
                atomic_store(&found, 1);
                break;
            }
            /* increment the base-36 string in place (cheaper than re-dividing) */
            for (int p = g_len - 1; p >= 0; p--) {
                char ch = pw[p];
                if (ch == '9') { pw[p] = 'a'; continue; }
                pw[p] = ch == 'z' ? '0' : (char)(ch + 1);
                break;
            }
        }
        atomic_fetch_add(&done, e - s);
    }
    return NULL;
}

static int parse_hex(const char *hex) {
    if (strlen(hex) != 64) return 0;
    for (int i = 0; i < 8; i++) {
        char buf[9];
        memcpy(buf, hex + i * 8, 8);
        buf[8] = 0;
        char *endp;
        target[i] = (uint32_t)strtoul(buf, &endp, 16);
        if (*endp) return 0;
    }
    return 1;
}

static void sleep_ms(int ms) {
    struct timespec ts = {ms / 1000, (long)(ms % 1000) * 1000000L};
    nanosleep(&ts, NULL);
}

int main(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr, "usage: %s <sha256_hex> <start> <end> <pass_len> <threads>\n", argv[0]);
        return 2;
    }
    if (!parse_hex(argv[1])) { fprintf(stderr, "bad hash\n"); return 2; }
    g_start = strtoull(argv[2], NULL, 10);
    g_end = strtoull(argv[3], NULL, 10);
    g_len = atoi(argv[4]);
    int threads = atoi(argv[5]);
    if (g_len < 1 || g_len > 16 || threads < 1 || threads > 256 || g_end < g_start) { fprintf(stderr, "bad args\n"); return 2; }

    pthread_t *tid = calloc((size_t)threads, sizeof(pthread_t));
    for (int i = 0; i < threads; i++) pthread_create(&tid[i], NULL, worker, NULL);

    uint64_t total = g_end - g_start;
    int ticks = 0;
    for (;;) {
        sleep_ms(15);
        uint64_t d = atomic_load(&done);
        if (atomic_load(&found) || d >= total) break;
        if (++ticks % 12 == 0) {
            printf("P %llu\n", (unsigned long long)d);
            fflush(stdout);
        }
    }
    for (int i = 0; i < threads; i++) pthread_join(tid[i], NULL);
    if (atomic_load(&found)) printf("F %llu\n", (unsigned long long)atomic_load(&found_idx));
    else printf("D %llu\n", (unsigned long long)atomic_load(&done));
    fflush(stdout);
    free(tid);
    return 0;
}
