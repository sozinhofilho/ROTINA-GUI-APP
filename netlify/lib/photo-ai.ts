// Estimativa de calorias por foto (desligada por padrão).
// Só funciona com ENABLE_PHOTO_AI=true e ANTHROPIC_API_KEY definidos.
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type { AiEstimate } from '../../shared/types.ts'
import { db, env, HttpError, PHOTO_BUCKET } from './server.ts'

// Modelo mais barato disponível.
export const PHOTO_MODEL = 'claude-haiku-5-5'

export function photoAiEnabled(): boolean {
  return env('ENABLE_PHOTO_AI') === 'true' && Boolean(env('ANTHROPIC_API_KEY'))
}

const EstimateSchema = z.object({
  description: z.string(),
  kcal: z.number().int(),
  protein_g: z.number(),
  carbs_g: z.number(),
  fat_g: z.number(),
})

export async function analyzePhoto(path: string, hint: string): Promise<AiEstimate> {
  if (!photoAiEnabled()) throw new HttpError(403, 'Análise por IA desligada')
  const file = await db().storage.from(PHOTO_BUCKET).download(path)
  if (file.error || !file.data) throw new HttpError(404, 'foto não encontrada')
  const data = Buffer.from(await file.data.arrayBuffer()).toString('base64')

  const client = new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') })
  let response
  try {
    response = await client.messages.parse({
      model: PHOTO_MODEL,
      max_tokens: 2000,
      output_config: { effort: 'low', format: zodOutputFormat(EstimateSchema) },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
            {
              type: 'text',
              text:
                'Estime as calorias e macronutrientes do prato da foto. Responda em português do Brasil. ' +
                'Em "description" liste os alimentos e porções estimadas em uma frase curta. ' +
                (hint ? `Contexto: refeição planejada "${hint.slice(0, 300)}".` : ''),
            },
          ],
        },
      ],
    })
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'IA ocupada, tente de novo em instantes')
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(500, 'ANTHROPIC_API_KEY inválida')
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `IA: ${err.message}`)
    throw err
  }
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'A IA não analisou esta foto')
  const out = response.parsed_output
  if (!out) throw new HttpError(502, 'A IA não devolveu uma estimativa válida')
  return {
    kcal: Math.max(0, Math.round(out.kcal)),
    protein: Math.round(out.protein_g),
    carbs: Math.round(out.carbs_g),
    fat: Math.round(out.fat_g),
    description: out.description.slice(0, 1000),
    model: PHOTO_MODEL,
  }
}
