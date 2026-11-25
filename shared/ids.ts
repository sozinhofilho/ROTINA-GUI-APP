// IDs determinísticos: a mesma entrada gera sempre o mesmo UUID.
// É o que torna as escritas idempotentes (repetir a chamada atualiza a mesma linha, não duplica).
import { normalizeText } from './schemas.ts'

/** cyrb128: hash não criptográfico de 128 bits, síncrono, igual no navegador e no Node. */
function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  h1 ^= h2 ^ h3 ^ h4
  h2 ^= h1
  h3 ^= h1
  h4 ^= h1
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]
}

/** UUID (versão 8, variante RFC) derivado das partes informadas. */
export function stableId(...parts: (string | number | null | undefined)[]): string {
  const key = parts.map((p) => (typeof p === 'string' ? normalizeText(p) : String(p ?? ''))).join('|')
  const hex = cyrb128(key).map((n) => n.toString(16).padStart(8, '0')).join('')
  const v = hex.split('')
  v[12] = '8'
  v[16] = ((parseInt(v[16], 16) & 0x3) | 0x8).toString(16)
  const h = v.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
