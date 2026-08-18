import { Inject, Injectable } from '@nestjs/common';
import { verifyJudgeCredential, type Db } from '@qhhoj/db';
import { DB } from '../config/config.module.js';

/**
 * Verifies a judge's `(name, token)` pair against `judge_nodes`.
 *
 * Delegates to `@qhhoj/db`'s `verifyJudgeCredential` — the same function
 * `apps/judged`'s bridge handshake calls — so a judge's credential is
 * checked identically no matter which of the two surfaces it presents it
 * to. See that function's doc comment for the hashing and comparison
 * details, and for why it fails closed on any error.
 */
@Injectable()
export class JudgeService {
  constructor(@Inject(DB) private readonly db: Db) {}

  verify(name: string, token: string): Promise<boolean> {
    return verifyJudgeCredential(this.db, name, token);
  }
}
