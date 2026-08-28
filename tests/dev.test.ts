import { expect, test } from 'bun:test'
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

test('development runs on Bun with CSS Modules, HMR and same-origin API proxying', async () => {
  const root = path.resolve(import.meta.dir, '..')
  const directory = await mkdtemp(path.join(tmpdir(), 'picwall-dev-test-'))
  const reserve = () => Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() })
  const backend = reserve()
  const frontend = reserve()
  const apiPort = backend.port
  const webPort = frontend.port
  await backend.stop(true)
  await frontend.stop(true)
  let child: Bun.Subprocess | undefined
  try {
    for (const name of ['src', 'server', 'types', 'public', 'index.html', 'tsconfig.json', 'package.json', 'vite.config.ts']) {
      await cp(path.join(root, name), path.join(directory, name), { recursive: true })
    }
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'), 'dir')
    await Bun.write(path.join(directory, '.sessions.json'), JSON.stringify({ marker: 'private-session-fixture' }))
    await Bun.write(path.join(directory, 'data/private.sqlite'), 'private-database-fixture')
    child = Bun.spawn([Bun.which('bun')!, '--no-orphans', 'run', 'dev'], {
      cwd: directory,
      env: { PATH: Bun.env.PATH, NODE_ENV: 'development', STORAGE_TYPE: 'local', PORT: String(apiPort), VITE_PORT: String(webPort), HOST: '127.0.0.1' },
      stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
    })
    const origin = `http://127.0.0.1:${webPort}`
    let ready = false
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) break
      try {
        const response = await fetch(`${origin}/api/auth/me`)
        if (response.ok) { await response.json(); ready = true; break }
        await response.body?.cancel()
      } catch {}
      await Bun.sleep(25)
    }
    if (!ready) throw new Error('Development servers did not become ready')
    const html = await (await fetch(origin)).text()
    expect(html).toContain('/@vite/client')
    const stylesheet = await (await fetch(`${origin}/src/components/PhotoWall.module.css?import`)).text()
    expect(stylesheet).toContain('export default')
    expect(stylesheet).toContain('headerContent')
    const upload = await fetch(`${origin}/api/upload`, { method: 'POST', headers: { origin } })
    expect(upload.status).toBe(401)
    const external = await fetch(`${origin}/api/upload`, { method: 'POST', headers: { origin: 'https://other.example' } })
    expect(external.status).toBe(403)
    for (const name of ['.sessions.json', 'data/private.sqlite']) {
      for (const route of ['/' + name, '/@fs' + path.join(directory, name)]) {
        const response = await fetch(origin + route)
        expect(response.status).toBe(403)
        expect(await response.text()).not.toContain('private-session-fixture')
      }
    }
    expect((await fetch(`${origin}/media/missing`)).status).toBe(400)
  } finally {
    if (child) { child.kill(); await child.exited }
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)
