import { rm, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

await rm('dist', { recursive: true, force: true })
await mkdir('dist/public', { recursive: true })

const frontend = await Bun.build({
  entrypoints: ['./index.html'],
  outdir: './dist/public',
  target: 'browser',
  minify: true,
  splitting: true,
  metafile: true,
  publicPath: '/',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
if (!frontend.success) throw new AggregateError(frontend.logs, 'Frontend build failed')

const server = await Bun.build({
  entrypoints: ['./server/index.ts'],
  outdir: './dist/server',
  target: 'bun',
  packages: 'external',
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
if (!server.success) throw new AggregateError(server.logs, 'Server build failed')

const maintenance = await Bun.build({
  entrypoints: ['./scripts/library.ts', './scripts/import_photos.ts', './scripts/auth.ts'],
  outdir: './dist/scripts',
  target: 'bun',
  packages: 'external',
})
if (!maintenance.success) throw new AggregateError(maintenance.logs, 'Maintenance tools build failed')

await Bun.write('dist/public/favicon.ico', Bun.file('public/favicon.ico'))

// Minification removes upstream notices; ship them alongside the browser bundle and runtime.
const packageDirectories = new Set<string>()
for (const input of Object.keys(frontend.metafile!.inputs)) {
  if (!input.includes('node_modules/')) continue
  let directory = path.dirname(path.resolve(input))
  while (directory !== path.dirname(directory)) {
    const metadata = Bun.file(path.join(directory, 'package.json'))
    if (await metadata.exists() && (await metadata.json()).name) {
      packageDirectories.add(directory)
      break
    }
    directory = path.dirname(directory)
  }
}
const project = await Bun.file('package.json').json()
async function runtimeNotices(name: string, from: string) {
  let directory = path.dirname(Bun.fileURLToPath(import.meta.resolve(name, path.join(from, 'package.json'))))
  while (directory !== path.dirname(directory)) {
    const metadata = Bun.file(path.join(directory, 'package.json'))
    if (await metadata.exists() && (await metadata.json()).name === name) break
    directory = path.dirname(directory)
  }
  if (packageDirectories.has(directory)) return
  packageDirectories.add(directory)
  const metadata = await Bun.file(path.join(directory, 'package.json')).json()
  for (const dependency of Object.keys({ ...metadata.dependencies, ...metadata.optionalDependencies })) {
    await runtimeNotices(dependency, directory)
  }
}
for (const name of Object.keys(project.dependencies)) await runtimeNotices(name, process.cwd())
const notices = ['PicWall2\n\n' + await Bun.file('LICENSE').text()]
for (const directory of [...packageDirectories].sort()) {
  const metadata = await Bun.file(path.join(directory, 'package.json')).json()
  const repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url
  const source = repository?.replace(/^git\+/, '').replace(/\.git$/, '') ?? metadata.homepage ?? ''
  const licenses = (await readdir(directory)).filter(name => /^(license|licence|copying|notice)(\.|$)/i.test(name)).sort()
  if (!licenses.length && metadata.license !== 'Unlicense') throw new Error('Missing upstream license: ' + metadata.name)
  notices.push([metadata.name + '@' + metadata.version, 'License: ' + metadata.license, 'Source: ' + source,
    ...await Promise.all(licenses.map(name => Bun.file(path.join(directory, name)).text()))].join('\n\n'))
}
await Bun.write('dist/public/licenses.txt', notices.join('\n\n' + '='.repeat(72) + '\n\n') + '\n')
const assets = frontend.outputs.map(output => path.basename(output.path)).concat('favicon.ico', 'licenses.txt')
for (const name of assets) {
  if (!/\.(js|css|html)$/.test(name)) continue
  const bytes = await Bun.file(`dist/public/${name}`).bytes()
  await Bun.write(`dist/public/${name}.gz`, Bun.gzipSync(bytes))
  await Bun.write(`dist/public/${name}.br`, brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }))
}
await Bun.write('dist/assets.json', JSON.stringify(assets))
console.log(`Built ${frontend.outputs.length} frontend assets, the Bun server, and maintenance tools.`)
