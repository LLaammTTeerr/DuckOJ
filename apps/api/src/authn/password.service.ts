import { Injectable } from '@nestjs/common';
import { hashPassword, verifyPassword } from './password.hash.js';

/**
 * The injectable seam over the KDF. The parameters themselves live in
 * `password.hash.ts` — a framework-free module `scripts/bootstrap-admin.ts`
 * can import without a Nest container; see its doc comment.
 */
@Injectable()
export class PasswordService {
  hash(plain: string): Promise<string> {
    return hashPassword(plain);
  }

  verify(hashed: string, plain: string): Promise<boolean> {
    return verifyPassword(hashed, plain);
  }
}
