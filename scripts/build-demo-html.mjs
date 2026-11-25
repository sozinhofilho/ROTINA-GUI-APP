// Gera rotina-demo.html: a demonstração do app num único arquivo (CSS e JS embutidos),
// que abre direto no navegador. Uso: npx vite build --mode demo && node scripts/build-demo-html.mjs
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const dir = new URL('../dist-demo/assets/', import.meta.url)
const files = readdirSync(dir)
const js = files.filter((f) => f.endsWith('.js'))
if (js.length !== 1) throw new Error(`esperado 1 JS, achei ${js.length}: ${js.join(', ')}`)
const css = files.filter((f) => f.endsWith('.css')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n')
const code = readFileSync(new URL(js[0], dir), 'utf8').replace(/<\/script/gi, '<\\/script')
const icon = readFileSync(new URL('../public/favicon.svg', import.meta.url), 'utf8')

const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(icon)}">
<title>Rotina (demonstração)</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script type="module">${code}</script>
</body>
</html>
`
const out = new URL('../rotina-demo.html', import.meta.url)
writeFileSync(out, html)
console.log(`rotina-demo.html: ${(html.length / 1024).toFixed(0)} KB`)
