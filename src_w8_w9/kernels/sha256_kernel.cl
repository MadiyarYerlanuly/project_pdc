/* ============================================================================
 * W8-W9: UNIVERSAL OPENCL GPU KERNEL (Module S4 - Yerkebulan & S5 - Madiyar)
 * Works on ANY GPU: Intel Iris Xe, Apple Silicon (M1/M2/M3), AMD Radeon, NVIDIA
 * Offloads 100% of SHA-256 brute-force math to GPU compute units so the host
 * CPU remains cool and responsive for MPI networking and Heartbeats.
 * ============================================================================ */

#define ROTR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define EP0(x) (ROTR(x, 2) ^ ROTR(x, 13) ^ ROTR(x, 22))
#define EP1(x) (ROTR(x, 6) ^ ROTR(x, 11) ^ ROTR(x, 25))
#define SIG0(x) (ROTR(x, 7) ^ ROTR(x, 18) ^ ((x) >> 3))
#define SIG1(x) (ROTR(x, 17) ^ ROTR(x, 19) ^ ((x) >> 10))

__constant uint K[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
    0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
    0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
    0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U
};

__constant char CHARSET[36] = {
    'a','b','c','d','e','f','g','h','i','j','k','l','m','n','o','p','q','r',
    's','t','u','v','w','x','y','z','0','1','2','3','4','5','6','7','8','9'
};

__kernel void sha256_crack_kernel(
    ulong start_index,
    int   pass_len,
    __global const uint *target_state,
    __global int        *found_flag,
    __global ulong      *matched_index
) {
    size_t gid = get_global_id(0);
    ulong idx = start_index + (ulong)gid;

    /* Early exit if another GPU work-item already cracked the password */
    if (*found_flag != 0) return;

    /* Generate candidate password directly in GPU registers (zero RAM bottleneck) */
    uchar block[64];
    for (int i = 0; i < 64; ++i) block[i] = 0;

    ulong tmp = idx;
    for (int pos = pass_len - 1; pos >= 0; --pos) {
        block[pos] = (uchar)CHARSET[tmp % 36];
        tmp /= 36;
    }
    block[pass_len] = 0x80; /* SHA-256 padding bit */

    /* Bit length in big-endian at end of 512-bit block */
    uint bitlen = (uint)(pass_len * 8);
    block[63] = (uchar)(bitlen & 0xff);
    block[62] = (uchar)((bitlen >> 8) & 0xff);

    uint m[64];
    for (int i = 0, j = 0; i < 16; ++i, j += 4) {
        m[i] = ((uint)block[j] << 24) | ((uint)block[j + 1] << 16) |
               ((uint)block[j + 2] << 8) | ((uint)block[j + 3]);
    }
    for (int i = 16; i < 64; ++i) {
        m[i] = SIG1(m[i - 2]) + m[i - 7] + SIG0(m[i - 15]) + m[i - 16];
    }

    uint a = 0x6a09e667U, b = 0xbb67ae85U, c = 0x3c6ef372U, d = 0xa54ff53aU;
    uint e = 0x510e527fU, f = 0x9b05688cU, g = 0x1f83d9abU, h = 0x5be0cd19U;

    for (int i = 0; i < 64; ++i) {
        uint t1 = h + EP1(e) + CH(e, f, g) + K[i] + m[i];
        uint t2 = EP0(a) + MAJ(a, b, c);
        h = g; g = f; f = e; e = d + t1;
        d = c; c = b; b = a; a = t1 + t2;
    }

    if ((a + 0x6a09e667U) == target_state[0] &&
        (b + 0xbb67ae85U) == target_state[1] &&
        (c + 0x3c6ef372U) == target_state[2] &&
        (d + 0xa54ff53aU) == target_state[3] &&
        (e + 0x510e527fU) == target_state[4] &&
        (f + 0x9b05688cU) == target_state[5] &&
        (g + 0x1f83d9abU) == target_state[6] &&
        (h + 0x5be0cd19U) == target_state[7]) {
        *found_flag = 1;
        *matched_index = idx;
    }
}
