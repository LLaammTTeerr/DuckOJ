import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { ContestsController } from './contests.controller.js';

@Module({ imports: [AuthnModule, AuthzModule], controllers: [ContestsController] })
export class ContestsModule {}
