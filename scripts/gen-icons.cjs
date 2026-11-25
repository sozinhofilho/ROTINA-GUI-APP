// Gera os ícones PNG do PWA a partir de public/favicon.svg (usa o Chromium do Playwright).
// Uso: node scripts/gen-icons.cjs (precisa do pacote playwright disponível)
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { chromium } = require('playwright')

const svg = readFileSync(path.join(__dirname, '../public/favicon.svg'), 'utf8')
const out = (f) => path.join(__dirname, '../public/icons', f)
async function main() {
const browser = await chromium.launch()
const page = await browser.newPage()
async function shot(file, size, pad = 0, bg = 'transparent') {
  await page.setViewportSize({ width: size, height: size })
  const inner = size - pad * 2
  await page.setContent(`<body style="margin:0;background:${bg}"><div style="padding:${pad}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`)
  await page.screenshot({ path: out(file), omitBackground: bg === 'transparent' })
}
await shot('icon-192.png', 192)
await shot('icon-512.png', 512)
await shot('icon-maskable-512.png', 512, 56, '#0f1720')
await shot('apple-touch-icon.png', 180, 0, '#0f1720')
await browser.close()
console.log('ícones gerados')
}
main()
