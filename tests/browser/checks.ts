const frame = document.querySelector<HTMLIFrameElement>('#app')!
const results = document.querySelector<HTMLOListElement>('#results')!
const run = document.querySelector<HTMLButtonElement>('#run')!
const doc = () => frame.contentDocument!
const text = () => doc().body?.textContent ?? ''
const buttons = () => Array.from(doc().querySelectorAll<HTMLButtonElement>('button'))
const button = (name: string) => buttons().find(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)!
const cards = () => buttons().filter(element => element.getAttribute('aria-label')?.startsWith('View Photo'))

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
async function until(check: () => unknown, message: string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(message)
}
async function navigate(path: string) {
  await new Promise<void>(resolve => { frame.onload = () => resolve(); frame.src = path })
}
async function check(name: string, work: () => Promise<void>) {
  const row = document.createElement('li')
  row.textContent = `RUNNING: ${name}`
  results.append(row)
  try { await work(); row.textContent = `PASS: ${name}` }
  catch (error) { row.textContent = `FAIL: ${name}: ${error instanceof Error ? error.message : error}`; throw error }
}

run.onclick = async () => {
  run.disabled = true
  results.replaceChildren()
  try {
    await check('Gallery mounts bounded, keyboard-focusable photo cards', async () => {
      await navigate('/')
      await until(() => cards().length > 0, 'Gallery did not load')
      assert(cards().length < 60, 'Gallery mounted an unbounded collection')
      assert(cards().every(element => element.tabIndex === 0), 'Cards are not keyboard-focusable')
    })
    await check('Filter switching ignores the abandoned slower response', async () => {
      button('#odd').click()
      await until(() => frame.contentWindow!.location.search.includes('odd'), 'Odd filter did not activate')
      button('#even').click()
      await until(() => cards().length && cards().every(element => Number(element.textContent?.match(/Photo (\d+)/)?.[1]) % 2 === 0), 'Even filter did not load')
      await new Promise(resolve => setTimeout(resolve, 200))
      assert(cards().every(element => Number(element.textContent?.match(/Photo (\d+)/)?.[1]) % 2 === 0), 'Stale odd response replaced the even filter')
    })
    await check('Original download failure can be retried without closing the modal', async () => {
      const card = cards()[0]!
      card.focus()
      card.click()
      await until(() => doc().querySelector('dialog[open]'), 'Photo dialog did not open')
      assert(doc().querySelector('dialog')!.contains(doc().activeElement), 'Dialog did not take focus')
      button('Load original').click()
      await until(() => button('Retry original'), 'Download failure did not offer retry')
      button('Retry original').click()
      await until(() => doc().querySelector('dialog img[src^="blob:"]'), 'Original retry did not load')
      button('Close View').click()
      await until(() => !doc().querySelector('dialog'), 'Dialog did not close')
      await until(() => doc().activeElement === card, 'Focus did not return to the selected card')
    })
    await check('Detail navigation loads another page and handles collection boundaries', async () => {
      button('All').click()
      await until(() => frame.contentWindow!.location.search === ''
        && cards().some(element => element.getAttribute('aria-label') === 'View Photo 129'), 'All filter did not load')
      button('View Photo 130').click()
      await until(() => button('Previous photo'), 'Navigation did not mount')
      assert(button('Previous photo').disabled, 'Previous should be disabled on first photo')
      for (let index = 129; index >= 69; index--) {
        await until(() => button('Next photo') && !button('Next photo').disabled, 'Next navigation stayed disabled')
        button('Next photo').click()
        await until(() => doc().querySelector('dialog h2')?.textContent === `Photo ${String(index).padStart(3, '0')}`, 'Next photo did not load')
      }
      button('Close View').click()
      await until(() => !doc().querySelector('dialog'), 'Dialog did not close')
    })
    await check('Admin uses bounded pages and resets page-local selection', async () => {
      await navigate('/admin')
      await until(() => doc().querySelectorAll('tbody tr').length === 60, 'First admin page did not load')
      doc().querySelector<HTMLInputElement>('input[aria-label="Select all photos on this page"]')!.click()
      await until(() => !!button('Batch Tags (60)'), 'Page selection count is wrong')
      const nav = doc().querySelector('nav[aria-label="Photos pages"]')!
      Array.from(nav.querySelectorAll('button')).find(element => element.textContent === 'Next')!.click()
      await until(() => nav.textContent?.includes('Page 2') && !nav.textContent.includes('Loading') && doc().querySelectorAll('tbody tr').length === 60, 'Second admin page did not load')
      assert(!buttons().some(element => element.textContent?.includes('Batch Tags')), 'Selection leaked to another page')
    })
    await check('Batch tags and photo edits update current rows', async () => {
      const selection = doc().querySelector<HTMLInputElement>('input[aria-label="Select all photos on this page"]')!
      selection.click()
      frame.contentWindow!.prompt = () => 'browser-test'
      await until(() => !!button('Batch Tags (60)'), 'Selection did not finish')
      button('Batch Tags (60)').click()
      await until(() => text().includes('Batch tags saved.'), 'Batch tags failed')
      assert(Array.from(doc().querySelectorAll('tbody tr')).every(row => row.textContent?.includes('browser-test')), 'Rows did not update after saving tags')
      button('Edit').click()
      await until(() => !!doc().querySelector('dialog[open] input'), 'Photo editor did not open')
      const input = doc().querySelector<HTMLInputElement>('dialog input')!
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
      setter.call(input, 'Browser edited title')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      doc().querySelector<HTMLFormElement>('dialog form')!.requestSubmit()
      await until(() => !doc().querySelector('dialog') && text().includes('Browser edited title'), 'Edited title did not appear')
    })
    await check('Upload retries busy responses and publishes processed photos', async () => {
      const image = await (await fetch('/__test/image.png')).blob()
      const transfer = new DataTransfer()
      transfer.items.add(new File([image], 'browser-upload.png', { type: 'image/png' }))
      const input = doc().querySelector<HTMLInputElement>('input[type="file"]')!
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await until(() => text().includes('Upload complete. 1 originals saved'), 'Upload did not finish')
      const requests: { method: string; path: string; uploadKey: string | null }[] = await (await fetch('/__test/requests')).json()
      const uploads = requests.filter(request => request.path === '/api/upload')
      assert(uploads.length === 2 && uploads[0]!.uploadKey === uploads[1]!.uploadKey, 'Retry changed upload identity')
      assert(!requests.some(request => request.method === 'GET' && ['/api/photos', '/api/jobs', '/api/trash'].includes(request.path)), 'UI made an unbounded list request')
    })
    const complete = document.createElement('p')
    complete.textContent = 'All 7 browser checks passed.'
    results.after(complete)
  } catch { /* Individual checks show their failure without hiding the test app. */ }
}
