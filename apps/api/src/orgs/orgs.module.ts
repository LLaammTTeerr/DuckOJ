import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { OrgsController } from './orgs.controller.js';
import { ProblemSetsController } from './problem-sets.controller.js';

@Module({
  imports: [AuthnModule, AuthzModule],
  controllers: [OrgsController, ProblemSetsController],
})
export class OrgsModule {}
