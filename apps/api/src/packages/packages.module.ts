import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { FilesystemPackageStore, PACKAGE_STORE, type PackageStore } from './package.store.js';
import { PackagesController } from './packages.controller.js';
import { InternalPackagesController } from './internal-packages.controller.js';
import { PackagesService } from './packages.service.js';

@Module({
  // `AuthnModule` for `JudgeGuard` (`@UseGuards(JudgeGuard)` on
  // `InternalPackagesController` needs it resolvable from this module's own
  // graph) — Task 7/8 built the store and the guard but wired neither into a
  // module, which is what this module closes.
  imports: [AuthnModule],
  controllers: [PackagesController, InternalPackagesController],
  providers: [
    PackagesService,
    {
      provide: PACKAGE_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): PackageStore => new FilesystemPackageStore(config.packageStoreDir),
    },
  ],
  // `ProblemAccessService` (`AuthzModule`) needs the store too, to read a
  // package's manifest when attaching it as a revision. `PackagesModule`
  // does not import `AuthzModule` anywhere in the graph, so this stays
  // acyclic without a `forwardRef`.
  exports: [PACKAGE_STORE],
})
export class PackagesModule {}
