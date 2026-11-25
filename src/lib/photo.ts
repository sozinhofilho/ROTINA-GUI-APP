// Comprime a foto no celular antes de enviar (máx. 1280 px, JPEG ~0,72).
import { api } from './api.ts'

export async function compressImage(file: File, maxSide = 1280, quality = 0.72): Promise<Blob> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  let width: number
  let height: number
  let source: CanvasImageSource
  if (bitmap) {
    width = bitmap.width
    height = bitmap.height
    source = bitmap
  } else {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('não foi possível ler a imagem'))
      el.src = URL.createObjectURL(file)
    })
    width = img.naturalWidth
    height = img.naturalHeight
    source = img
  }
  const scale = Math.min(1, maxSide / Math.max(width, height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(width * scale)
  canvas.height = Math.round(height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas indisponível')
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  bitmap?.close()
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('falha ao comprimir a imagem')
  return blob
}

export async function uploadPhoto(date: string, file: File): Promise<{ path: string; url: string | null }> {
  const blob = await compressImage(file)
  return api(`/api/photo?date=${date}`, {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: blob,
  })
}
