import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { AuthzModule } from '../authz/authz.module.js';
import { OrgsController } from './orgs.controller.js';

@Module({ imports: [AuthnModule, AuthzModule], controllers: [OrgsController] })
export class OrgsModule {}
