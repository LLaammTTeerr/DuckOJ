import { Global, Module } from '@nestjs/common';
import { createDb, type Db } from '@qhhoj/db';
import { loadConfig, type AppConfig } from './config.schema.js';

export const APP_CONFIG = Symbol('APP_CONFIG');
export const DB = Symbol('DB');

@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig(process.env) },
    {
      provide: DB,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig): Db => createDb(config.databaseUrl).db,
    },
  ],
  exports: [APP_CONFIG, DB],
})
export class ConfigModule {}
