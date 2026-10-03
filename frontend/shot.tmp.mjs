import { chromium } from 'playwright'
import fs from 'fs'
const [,, hash, out, w = '1400', h = '1000'] = process.argv
const jar = fs.readFileSync(process.env.JAR, 'utf8').split('\n').filter((l) => l && (!l.startsWith('#') || l.startsWith('#HttpOnly_')))
const cookies = jar.map((l) => { const p = l.replace('#HttpOnly_', '').split('\t'); return { name: p[5], value: p[6], domain: '127.0.0.1', path: '/' } })
const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: +w, height: +h } })
await ctx.addCookies(cookies)
await ctx.route('http://127.0.0.1:7879/**', async (route) => {
  const r = route.request()
  try {
    const res = await fetch(r.url(), { method: r.method(), headers: { ...r.headers(), cookie: cookieHeader }, body: r.postData() ?? undefined })
    const body = Buffer.from(await res.arrayBuffer())
    await route.fulfill({ status: res.status, headers: Object.fromEntries([...res.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding'].includes(k))), body })
  } catch { await route.abort() }
})
const page = await ctx.newPage()
await page.goto(`http://127.0.0.1:7879/${hash}`, { waitUntil: 'commit' })
await page.waitForTimeout(+(process.env.WAIT ?? 6000))
const cdp = await ctx.newCDPSession(page)
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
fs.writeFileSync(out, Buffer.from(data, 'base64'))
await browser.close()
