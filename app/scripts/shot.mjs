import puppeteer from 'puppeteer-core'

const url = process.argv[2] ?? 'http://localhost:5173/'
const out = process.argv[3] ?? 'app.png'
const width = Number(process.argv[4] ?? 430)
const height = Number(process.argv[5] ?? 800)
const actions = process.argv[6] ?? '' // e.g. "click:.tab:nth-child(2)"

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--force-device-scale-factor=2'],
  defaultViewport: { width, height, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
})

const page = await browser.newPage()
const geo = process.argv[7]
if (geo) {
  const [lat, lon] = geo.split(',').map(Number)
  await browser.defaultBrowserContext().overridePermissions(new URL(url).origin, ['geolocation'])
  await page.setGeolocation({ latitude: lat, longitude: lon, accuracy: 6 })
}
const logs = []
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`))

await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 })
await new Promise((r) => setTimeout(r, 7000))

for (const act of actions.split(';').filter(Boolean)) {
  const [verb, ...rest] = act.split(':')
  const arg = rest.join(':')
  if (verb === 'click') {
    await page.click(arg).catch((e) => logs.push(`[actfail] click ${arg}: ${e.message}`))
    await new Promise((r) => setTimeout(r, 2500))
  } else if (verb === 'tapxy') {
    const [x, y] = arg.split(',').map(Number)
    await page.touchscreen.tap(x, y)
    await new Promise((r) => setTimeout(r, 2000))
  } else if (verb === 'mousexy') {
    const [x, y] = arg.split(',').map(Number)
    await page.mouse.click(x, y)
    await new Promise((r) => setTimeout(r, 2000))
  } else if (verb === 'wait') {
    await new Promise((r) => setTimeout(r, Number(arg)))
  } else if (verb === 'eval') {
    await page.evaluate(arg).catch((e) => logs.push(`[actfail] eval: ${e.message}`))
    await new Promise((r) => setTimeout(r, 1500))
  }
}

await page.screenshot({ path: out })
console.log(logs.slice(0, 80).join('\n'))
console.log('SCREENSHOT_OK', out)
await browser.close()
