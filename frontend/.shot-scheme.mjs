import { chromium } from 'playwright'
const [url, out, w, h, scheme] = process.argv.slice(2)
const b = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const p = await b.newPage({ viewport: { width: +w, height: +h }, colorScheme: scheme })
await p.goto(url, { waitUntil: 'networkidle' })
await p.waitForTimeout(2500)
await p.screenshot({ path: out })
await b.close()
