import { S3Client } from 'bun'
import path from 'node:path'
import { createLibrary } from '../server/library/config'
import type { Library } from '../server/library/service'
import {
  backupLibrary, checkLibrary, duplicates, exportManifest, garbageCollect, migrateLibrary, restoreLibrary,
  validateMigrationDestination, validateRestoreDestination,
} from '../server/library/maintenance'

const help = `Offline library maintenance (stop the server first).

bun scripts/library.ts migrate --source-root <legacy project> --root <new library> --offline [--source-storage local|s3]
bun scripts/library.ts check|duplicates|rebuild|retry --root <library>
bun scripts/library.ts gc --root <library> [--retention-days 7] [--apply]
bun scripts/library.ts export --root <library> --output <manifest.json>
bun scripts/library.ts backup --root <library> --output <new backup directory>
bun scripts/library.ts restore --root <isolated empty library> --from <backup directory>

The destination object store uses STORAGE_TYPE and S3_* settings. S3 migration reads
legacy uploads/ using SOURCE_S3_* (falling back to S3_*). It never deletes legacy data.
GC is a dry run unless --apply is supplied; retention cannot be less than seven days.`

function parseArguments(args: string[]) {
  const command = args.shift()
  const flags = new Map<string, string | true>()
  const booleans = new Set(['offline', 'apply', 'help'])
  const names = new Set(['root', 'source-root', 'source-storage', 'retention-days', 'output', 'from', ...booleans])
  while (args.length) {
    const argument = args.shift()!
    if (!argument.startsWith('--') || !names.has(argument.slice(2))) throw new Error('Unknown argument: ' + argument)
    const name = argument.slice(2)
    if (flags.has(name)) throw new Error('Duplicate argument: ' + argument)
    if (booleans.has(name)) flags.set(name, true)
    else {
      const value = args.shift()
      if (!value || value.startsWith('--')) throw new Error('Missing value for ' + argument)
      flags.set(name, value)
    }
  }
  return { command, flags }
}

async function main() {
  const { command, flags } = parseArguments(process.argv.slice(2))
  if (!command || command === '--help' || flags.has('help')) { console.log(help); return }
  const permitted: Record<string, string[]> = {
    migrate: ['root', 'source-root', 'source-storage', 'offline'], check: ['root'], duplicates: ['root'],
    rebuild: ['root'], retry: ['root'], gc: ['root', 'retention-days', 'apply'], export: ['root', 'output'],
    backup: ['root', 'output'], restore: ['root', 'from'],
  }
  if (!permitted[command]) throw new Error('Unknown command: ' + command)
  for (const flag of flags.keys()) if (!permitted[command]!.includes(flag)) throw new Error('--' + flag + ' is not valid for ' + command)
  const required = (name: string) => {
    const value = flags.get(name)
    if (typeof value !== 'string') throw new Error('--' + name + ' is required')
    return value
  }
  const root = path.resolve(required('root'))
  if (command === 'migrate') {
    required('source-root')
    if (!flags.has('offline')) throw new Error('Stop the legacy service, then pass --offline to confirm it is stopped')
    if (!['local', 's3'].includes(String(flags.get('source-storage') ?? 'local'))) throw new Error('Invalid --source-storage')
    await validateMigrationDestination(required('source-root'), root)
  }
  if (['export', 'backup'].includes(command)) required('output')
  if (command === 'restore') await validateRestoreDestination(required('from'), root)
  const retentionDays = flags.has('retention-days') ? Number(required('retention-days')) : 7
  if (!Number.isFinite(retentionDays) || retentionDays < 7) throw new Error('--retention-days must be at least 7')
  if (command !== 'migrate' && command !== 'restore' && !await Bun.file(path.join(root, 'catalog.sqlite')).exists()) {
    throw new Error('No catalog.sqlite in ' + root)
  }
  let library: Library | undefined
  try {
    library = await createLibrary(root, true)
    let result: unknown
    switch (command) {
      case 'migrate': {
        const sourceStorage = flags.get('source-storage') ?? 'local'
        const client = sourceStorage === 's3' ? new S3Client({
          region: process.env.SOURCE_S3_REGION || process.env.S3_REGION || 'auto',
          endpoint: process.env.SOURCE_S3_ENDPOINT || process.env.S3_ENDPOINT,
          bucket: process.env.SOURCE_S3_BUCKET || process.env.S3_BUCKET,
          accessKeyId: process.env.SOURCE_S3_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
          secretAccessKey: process.env.SOURCE_S3_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
          sessionToken: process.env.SOURCE_S3_SESSION_TOKEN || process.env.S3_SESSION_TOKEN || undefined,
        }) : undefined
        const migration = await migrateLibrary(library, {
          sourceRoot: required('source-root'),
          readOriginal: client ? async photo => new Uint8Array(await client.file('uploads/' + photo.id).arrayBuffer()) : undefined,
        })
        if (migration.failures.length) process.exitCode = 1
        result = migration
        break
      }
      case 'check': {
        const check = await checkLibrary(library)
        if (!check.ok) process.exitCode = 1
        result = check
        break
      }
      case 'duplicates': result = duplicates(library); break
      case 'gc': result = await garbageCollect(library, { apply: flags.has('apply'), retentionDays }); break
      case 'export': await exportManifest(library, required('output')); result = { manifest: path.resolve(required('output')) }; break
      case 'backup': await backupLibrary(library, required('output')); result = { backup: path.resolve(required('output')) }; break
      case 'restore': result = await restoreLibrary(library, required('from')); break
      case 'rebuild':
      case 'retry': {
        if (command === 'rebuild') await library.rebuild(); else await library.recover()
        const failed = library.catalog.jobs().filter(job => job.status === 'failed')
        if (failed.length) process.exitCode = 1
        result = { failed }
        break
      }
    }
    console.log(JSON.stringify(result, null, 2))
  } finally { await library?.close() }
}

await main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
