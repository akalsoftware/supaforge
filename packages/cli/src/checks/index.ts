import { CheckRegistry } from './registry.js'
import { SchemaCheck } from './schema.js'
import { RlsCheck } from './rls.js'
import { RlsCoverageCheck } from './rls-coverage.js'
import { EdgeFunctionsCheck } from './edge-functions.js'
import { StorageCheck } from './storage.js'
import { AuthCheck } from './auth.js'
import { CronCheck } from './cron.js'
import { DataCheck } from './data.js'
import { WebhooksCheck } from './webhooks.js'
import { RealtimeCheck } from './realtime.js'
import { VaultCheck } from './vault.js'
import { ExtensionsCheck } from './extensions.js'
import { MigrationsCheck } from './migrations.js'
import { RolesCheck } from './roles.js'
import { QueuesCheck } from './queues.js'

export interface RegistryOptions {
  /** Enable file-level drift detection in the storage check. */
  includeFiles?: boolean
}

export function createDefaultRegistry(options: RegistryOptions = {}): CheckRegistry {
  const registry = new CheckRegistry()
  registry.register(new SchemaCheck())
  registry.register(new RlsCheck())
  registry.register(new RlsCoverageCheck())
  registry.register(new EdgeFunctionsCheck())
  registry.register(new StorageCheck(undefined, options.includeFiles ?? false))
  registry.register(new AuthCheck())
  registry.register(new CronCheck())
  registry.register(new DataCheck())
  registry.register(new WebhooksCheck())
  registry.register(new RealtimeCheck())
  registry.register(new VaultCheck())
  registry.register(new ExtensionsCheck())
  registry.register(new MigrationsCheck())
  registry.register(new RolesCheck())
  registry.register(new QueuesCheck())
  return registry
}

export { CheckRegistry } from './registry.js'
export { Check, type CheckContext } from './base.js'
export { SchemaCheck } from './schema.js'
export { RlsCheck } from './rls.js'
export { RlsCoverageCheck } from './rls-coverage.js'
export { EdgeFunctionsCheck } from './edge-functions.js'
export { StorageCheck } from './storage.js'
export { AuthCheck } from './auth.js'
export { CronCheck } from './cron.js'
export { DataCheck } from './data.js'
export { WebhooksCheck } from './webhooks.js'
export { RealtimeCheck } from './realtime.js'
export { VaultCheck } from './vault.js'
export { ExtensionsCheck } from './extensions.js'
export { MigrationsCheck } from './migrations.js'
export { RolesCheck } from './roles.js'
export { QueuesCheck } from './queues.js'
