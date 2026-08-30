import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { OrgsController } from './orgs.controller.js';
import { ProblemSetsController } from './problem-sets.controller.js';
import { TeamsController } from './teams.controller.js';

@Module({
  imports: [AuthnModule, AuthzModule],
  controllers: [OrgsController, ProblemSetsController, TeamsController],
})
export class OrgsModule {}
