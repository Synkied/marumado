import { chromium } from 'playwright'
const [url, out, w, h, full] = process.argv.slice(2)
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 })
const errs = []
p.on('console', (m) => m.type() === 'error' && errs.push(m.text()))
p.on('pageerror', (e) => errs.push(String(e)))
await p.goto(url, { waitUntil: 'networkidle' })
await p.waitForTimeout(2500)
await p.screenshot({ path: out, fullPage: full === 'full' })
await b.close()
console.log('saved', out, errs.length ? '\nERRORS:\n' + errs.join('\n') : '')
