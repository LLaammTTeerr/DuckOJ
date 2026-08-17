import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { schema, type Db } from '@qhhoj/db';
import type { MeResponseDto, RegisterRequestDto } from '@qhhoj/contracts';
import { DB } from '../config/config.module.js';
import { AppError } from '../common/app.error.js';
import { PasswordService } from './password.service.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PasswordService) private readonly passwords: PasswordService,
  ) {}

  async register(input: RegisterRequestDto): Promise<MeResponseDto> {
    await this.assertAvailable('username', input.username);
    await this.assertAvailable('email', input.email);

    const [user] = await this.db
      .insert(schema.users)
      .values({
        username: input.username,
        email: input.email,
        displayName: input.displayName,
        passwordHash: await this.passwords.hash(input.password),
      })
      .returning();

    return toMe(user!, false);
  }

  private async assertAvailable(field: 'username' | 'email', value: string): Promise<void> {
    const column = field === 'username' ? schema.users.username : schema.users.email;
    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`lower(${column}) = lower(${value})`)
      .limit(1);
    if (existing.length > 0) {
      throw new AppError(409, `${field}_taken`, `That ${field} is already registered.`);
    }
  }
}

export function toMe(
  user: typeof schema.users.$inferSelect,
  totpEnabled: boolean,
): MeResponseDto {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    globalRole: user.globalRole,
    locale: user.locale,
    timezone: user.timezone,
    totpEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}
