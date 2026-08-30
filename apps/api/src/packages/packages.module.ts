import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { AuthnModule } from '../authn/authn.module.js';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.schema.js';
import { FilesystemPackageStore, PACKAGE_STORE, type PackageStore } from './package.store.js';
import { DRAFT_STORE, FilesystemDraftStore, type DraftStore } from './draft.store.js';
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
    // D87's draft trees live under the package store's own directory, in a
    // `drafts/` subtree: they are the same kind of thing (bytes a setter
    // uploaded, on the volume every worker shares) with the same operational
    // needs, and a second configured path would be a second thing to mount,
    // back up and run out of space on. `drafts/` cannot collide with a
    // package blob — `FilesystemPackageStore` shards by the first two
    // characters of a 64-hex hash, and `drafts` is neither.
    {
      provide: DRAFT_STORE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): DraftStore =>
        new FilesystemDraftStore(join(config.packageStoreDir, 'drafts')),
    },
  ],
  // `ProblemAccessService` (`AuthzModule`) needs the store too, to read a
  // package's manifest when attaching it as a revision. `PackagesModule`
  // does not import `AuthzModule` anywhere in the graph, so this stays
  // acyclic without a `forwardRef`. `DRAFT_STORE` and `PackagesService` are
  // exported for `ProblemsModule`'s D87 draft endpoints, which build a
  // package out of a draft and then store it through the very same `upload`
  // a CLI-built archive goes through.
  exports: [PACKAGE_STORE, DRAFT_STORE, PackagesService],
})
export class PackagesModule {}
