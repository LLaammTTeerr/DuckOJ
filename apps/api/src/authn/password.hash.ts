/**
 * The password KDF and its parameters, with no framework attached.
 *
 * Split out of `password.service.ts` so `scripts/bootstrap-admin.ts` — which
 * writes a `users` row directly and has no Nest container, no
 * `reflect-metadata`, and no decorator support in `scripts/tsconfig.json` —
 * can hash the first admin's password with *these* parameters rather than a
 * second copy of them. A bootstrap admin hashed at weaker settings than
 * every other account is exactly the drift a duplicated constant produces,
 * and nothing downstream would ever notice: argon2's encoded hash carries
 * its own parameters, so `verify` keeps working and the account is just
 * quietly cheaper to crack.
 *
 * `PasswordService` stays the seam the API injects; it is now a thin
 * delegate over this module.
 */
import { Algorithm, hash, verify } from '@node-rs/argon2';

/** OWASP-recommended argon2id parameters: 19 MiB, 2 iterations, 1 lane. */
export const PASSWORD_HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, PASSWORD_HASH_OPTIONS);
}

export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, PASSWORD_HASH_OPTIONS);
  } catch {
    return false;
  }
}
