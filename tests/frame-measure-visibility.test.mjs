import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

test('133 个历史网页屏幕外停止高度扫描，返回视区恢复且保留文档', async () => {
  const source = await readFile(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent('<main></main>')
    await page.evaluate(source => {
      window.__ModuleLoader__ = { load(d) { window.client = d.factory(() => ({})) } }
      window.eval(source)
      window.framesUnderTest = []
      for (let i = 0; i < 133; i++) {
        const life = client.createTavernMessageFrameLifecycle({ content: '<p>history</p>', turn: i + 1, runtimeReporting: false })
        const stop = life.start(() => {})
        const descriptor = life.snapshot().visibleDocument
        const reporter = descriptor.html.match(/<script data-dsh-tavern-frame>([\s\S]*?)<\/script>/)[1]
        const frame = document.createElement('iframe')
        frame.style.cssText = 'display:block;height:100px;width:300px;'
        frame.srcdoc = '<body><input value="retained"><p>history</p><script>window.scans=0;const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){window.scans++;return rect.call(this)};</' + 'script><script>' + reporter + '</' + 'script>'
        document.querySelector('main').append(frame)
        descriptor.ref(frame)
        framesUnderTest.push({ frame, stop, descriptor })
      }
    }, source)
    await page.waitForFunction(() => framesUnderTest.every(x => typeof x.frame.contentWindow.scans === 'number'))
    await page.waitForTimeout(300)
    const results = await page.evaluate(async () => {
      const mutate = () => framesUnderTest.forEach(({ frame }) => frame.contentDocument.querySelector('p').append(frame.contentDocument.createElement('b')))
      const counts = () => framesUnderTest.map(x => x.frame.contentWindow.scans)
      const before = counts(); mutate(); await new Promise(r => setTimeout(r, 200));
      const after = counts()
      const active = after.filter((n, i) => n > before[i]).length
      const last = framesUnderTest.at(-1), win = last.frame.contentWindow
      last.frame.scrollIntoView(); await new Promise(r => setTimeout(r, 200))
      const restored = win.scans > after.at(-1)
      const retained = win === last.frame.contentWindow && last.frame.contentDocument.querySelector('input').value === 'retained'
      framesUnderTest.forEach(({ stop, descriptor }) => { stop(); descriptor.ref(null) })
      return { active, restored, retained }
    })
    assert.ok(results.active > 0 && results.active <= 12, JSON.stringify(results))
    assert.equal(results.restored, true)
    assert.equal(results.retained, true)
    console.log('133 frames:', JSON.stringify(results))
  } finally { await browser.close() }
})

test('时钟换字与 transform 动画不触发整页测高；文字撑高仍会上报', async () => {
  const { buildTavernFrameDocument } = await import('./fixtures/helper-host-harness.mjs').then(m => m.helperClient)
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.route('**/*', route => route.abort())
    const doc = buildTavernFrameDocument({ token: 'perf', content: '<b id="clock">0</b><div id="card">卡片</div><p id="grow">短</p>' })
      .replace('<body class="no-blur">', '<body class="no-blur"><script>window.scans=0;const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){window.scans++;return rect.call(this)};</' + 'script>')
    await page.setContent('<iframe style="width:300px;height:48px;border:0"></iframe>')
    await page.evaluate(doc => { window.heights = []; onmessage = e => { if (e.data.type === 'dsh-tavern-frame-height') { heights.push(e.data.height); document.querySelector('iframe').style.height = e.data.height + 'px' } }; document.querySelector('iframe').srcdoc = doc }, doc)
    const frame = page.frames()[1]
    await frame.waitForFunction(() => typeof window.scans === 'number' && document.readyState === 'complete')
    await page.waitForTimeout(300)
    const scans = await frame.evaluate(async () => {
      const before = window.scans
      for (let i = 0; i < 10; i++) {
        document.getElementById('clock').textContent = String(i)
        document.getElementById('card').style.transform = 'translateY(' + i + 'px)'
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
      }
      return window.scans - before
    })
    assert.equal(scans, 0)
    const height = await page.evaluate(() => heights.at(-1))
    await frame.evaluate(() => { document.getElementById('grow').textContent = '很长的文字 '.repeat(200) })
    await page.waitForFunction(h => heights.at(-1) > h + 100, height)
  } finally { await browser.close() }
})
