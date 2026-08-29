import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { MailModule } from './mail/mail.module.js';
import { HealthModule } from './health/health.module.js';
import { DocsModule } from './docs/docs.module.js';
import { AuthnModule } from './authn/authn.module.js';
import { AuthzModule } from './authz/authz.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ContestsModule } from './contests/contests.module.js';
import { OrgsModule } from './orgs/orgs.module.js';
import { ProblemsModule } from './problems/problems.module.js';
import { SubmissionsModule } from './submissions/submissions.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PackagesModule } from './packages/packages.module.js';
import { LanguagesModule } from './languages/languages.module.js';
import { TagsModule } from './tags/tags.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule,
    MailModule,
    HealthModule,
    DocsModule,
    AuthnModule,
    AuthzModule,
    AdminModule,
    OrgsModule,
    ContestsModule,
    ProblemsModule,
    SubmissionsModule,
    RealtimeModule,
    PackagesModule,
    LanguagesModule,
    TagsModule,
    UsersModule,
    NotificationsModule,
  ],
})
export class AppModule {}
