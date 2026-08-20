import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { ProblemsController } from './problems.controller.js';

@Module({ imports: [AuthnModule, AuthzModule], controllers: [ProblemsController] })
export class ProblemsModule {}
