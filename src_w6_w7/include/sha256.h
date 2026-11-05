#ifndef SHA256_H
#define SHA256_H

#include <stdint.h>
#include <stddef.h>

/* ============================================================================
 * W6-W7: SERIAL CRYPTOGRAPHY MODULE (Module S5 - Madiyar)
 * Standard FIPS 180-4 / RFC 6234 SHA-256 implementation & keyspace mapper.
 * ============================================================================ */

typedef struct {
    uint8_t  data[64];
    uint32_t datalen;
    uint64_t bitlen;
    uint32_t state[8];
} SHA256_CTX;

/* Core SHA-256 functions */
void sha256_init(SHA256_CTX *ctx);
void sha256_update(SHA256_CTX *ctx, const uint8_t *data, size_t len);
void sha256_final(SHA256_CTX *ctx, uint8_t hash[32]);

/* Helper: Compute SHA-256 in one call */
void sha256_compute(const uint8_t *data, size_t len, uint8_t hash[32]);

/* Helper: Convert 32-byte binary hash to 64-character hex string */
void sha256_to_hex(const uint8_t hash[32], char hex_out[65]);

/* Helper: Parse 64-character hex string into 32-byte binary hash */
int  sha256_from_hex(const char *hex_in, uint8_t hash_out[32]);

/* Helper: Map a 64-bit numeric index to a candidate password string */
void index_to_password(uint64_t index, int pass_len, char *out_buf);

/* Self-test against NIST FIPS-180-4 official vectors */
int  sha256_self_test(void);

#endif /* SHA256_H */
