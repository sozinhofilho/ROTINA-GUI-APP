// Validação (zod) de tudo que entra nas Functions: operações, importação de plano e de dia.
import { z } from 'zod'
import { isISODate } from './dates.ts'

z.config(z.locales.pt())

const isoDate = z.string().refine(isISODate, 'data deve ser AAAA-MM-DD')
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'horário deve ser HH:MM')
const uuid = z.string().uuid()
const kcal = z.number().int().min(0).max(20000)
const macro = z.number().min(0).max(2000).nullable()
export const pace = z.string().regex(/^\d{1,2}:[0-5]\d$/, 'pace deve ser mm:ss (min/km), ex.: 5:30')
const shortText = z.string().max(300)
const longText = z.string().max(4000)

export const SettingsSchema = z.object({
  calorie_goal: z.number().int().min(500).max(10000),
  tolerance_pct: z.number().min(0).max(100),
  base_expenditure: z.number().int().min(0).max(10000).nullable(),
  timezone: z.string().min(1).max(60),
})

export const MealItemSchema = z.object({
  food: shortText,
  qty: z.string().max(60),
  kcal: kcal.nullable(),
})

export const PlanMealSchema = z.object({
  id: uuid,
  weekday: z.number().int().min(0).max(6),
  name: z.string().min(1).max(80),
  time: hhmm,
  description: longText,
  items: z.array(MealItemSchema).max(40),
  kcal,
  protein: macro,
  carbs: macro,
  fat: macro,
  sort: z.number().int(),
})

export const WorkoutKindSchema = z.enum(['hyrox', 'run', 'strength', 'other'])

export const ExerciseSchema = z.object({
  name: shortText,
  sets: z.string().max(20),
  reps: z.string().max(20),
})

export const PlanWorkoutSchema = z.object({
  id: uuid,
  weekday: z.number().int().min(0).max(6),
  name: z.string().min(1).max(80),
  kind: WorkoutKindSchema,
  time: hhmm.nullable(),
  details: longText,
  exercises: z.array(ExerciseSchema).max(40),
  duration_min: z.number().int().min(0).max(1440).nullable(),
  kcal: kcal.nullable(),
  sort: z.number().int(),
})

export const DayOverrideSchema = z.object({
  id: uuid,
  plan_workout_id: uuid,
  from_date: isoDate,
  to_date: isoDate,
})

export const AiEstimateSchema = z.object({
  kcal,
  protein: macro,
  carbs: macro,
  fat: macro,
  description: z.string().max(1000),
  model: z.string().max(60),
})

export const MealLogSchema = z.object({
  id: uuid,
  date: isoDate,
  plan_meal_id: uuid.nullable(),
  meal_name: z.string().max(80),
  done: z.boolean(),
  kcal_planned: kcal.nullable(),
  kcal_real: kcal.nullable(),
  note: longText,
  photo_path: z.string().max(300).nullable(),
  ai_estimate: AiEstimateSchema.nullable(),
})

export const WorkoutLogSchema = z.object({
  id: uuid,
  date: isoDate,
  plan_workout_id: uuid.nullable(),
  name: z.string().max(120),
  done: z.boolean(),
  duration_min: z.number().int().min(0).max(1440).nullable(),
  kcal: kcal.nullable(),
  distance_m: z.number().min(0).max(1_000_000).nullable(),
  avg_hr: z.number().min(0).max(260).nullable(),
  avg_pace: pace.nullable(),
  note: longText,
  source: z.enum(['manual', 'strava', 'import']),
  strava_activity_id: z.number().int().nullable(),
})

export const ExtraCategorySchema = z.enum(['alcool', 'lanche', 'refeicao', 'outro'])

export const ExtraEntrySchema = z.object({
  id: uuid,
  date: isoDate,
  time: hhmm.nullable(),
  description: z.string().min(1).max(300),
  kcal,
  category: ExtraCategorySchema,
})

// ---------- Operações (fila offline -> POST /api/mutate) ----------

export const OpSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('meal_log.upsert'), row: MealLogSchema }),
  z.object({ t: z.literal('meal_log.delete'), id: uuid }),
  z.object({ t: z.literal('workout_log.upsert'), row: WorkoutLogSchema }),
  z.object({ t: z.literal('workout_log.delete'), id: uuid }),
  z.object({
    t: z.literal('workout_log.assign'),
    id: uuid,
    plan_workout_id: uuid.nullable(),
  }),
  z.object({ t: z.literal('extra.upsert'), row: ExtraEntrySchema }),
  z.object({ t: z.literal('extra.delete'), id: uuid }),
  z.object({ t: z.literal('override.upsert'), row: DayOverrideSchema }),
  z.object({ t: z.literal('override.delete'), id: uuid }),
  z.object({ t: z.literal('plan_meal.upsert'), row: PlanMealSchema }),
  z.object({ t: z.literal('plan_meal.delete'), id: uuid }),
  z.object({ t: z.literal('plan_workout.upsert'), row: PlanWorkoutSchema }),
  z.object({ t: z.literal('plan_workout.delete'), id: uuid }),
  z.object({ t: z.literal('settings.update'), row: SettingsSchema.partial() }),
])
export type Op = z.infer<typeof OpSchema>

export const MutateBodySchema = z.object({ ops: z.array(OpSchema).min(1).max(200) })

// ---------- Importar plano (JSON colado) ----------

const WEEKDAY_ALIASES: Record<string, number[]> = {
  dom: [0], domingo: [0],
  seg: [1], segunda: [1], 'segunda-feira': [1],
  ter: [2], terca: [2], 'terca-feira': [2],
  qua: [3], quarta: [3], 'quarta-feira': [3],
  qui: [4], quinta: [4], 'quinta-feira': [4],
  sex: [5], sexta: [5], 'sexta-feira': [5],
  sab: [6], sabado: [6],
  todos: [0, 1, 2, 3, 4, 5, 6],
  uteis: [1, 2, 3, 4, 5],
  fds: [0, 6],
}

export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const WeekdayInput = z.union([
  z.number().int().min(0).max(6).transform((n) => [n]),
  z.string().transform((s, ctx) => {
    const v = WEEKDAY_ALIASES[normalizeText(s)]
    if (!v) {
      ctx.addIssue({ code: 'custom', message: `dia da semana inválido: "${s}"` })
      return z.NEVER
    }
    return v
  }),
])

const WeekdaysField = z
  .union([WeekdayInput, z.array(WeekdayInput).min(1)])
  .transform((v) => {
    const flat = Array.isArray(v[0]) ? (v as number[][]).flat() : (v as number[])
    return [...new Set(flat)].sort()
  })

// Campos omitidos: em item novo usam o padrão; em item que já existe (mesmo dia + nome) mantêm o valor atual.
const ImportMeal = z.object({
  weekdays: WeekdaysField.default([0, 1, 2, 3, 4, 5, 6]),
  name: z.string().min(1).max(80),
  time: hhmm.optional(),
  description: longText.optional(),
  items: z.array(MealItemSchema.extend({ kcal: kcal.nullable().default(null) })).max(40).optional(),
  kcal: kcal.optional(),
  protein: macro.optional(),
  carbs: macro.optional(),
  fat: macro.optional(),
})
export type ImportMealInput = z.infer<typeof ImportMeal>

const ImportWorkout = z.object({
  weekdays: WeekdaysField,
  name: z.string().min(1).max(80),
  kind: WorkoutKindSchema.optional(),
  time: hhmm.nullable().optional(),
  details: longText.optional(),
  exercises: z.array(ExerciseSchema).max(40).optional(),
  duration_min: z.number().int().min(0).max(1440).nullable().optional(),
  kcal: kcal.nullable().optional(),
})
export type ImportWorkoutInput = z.infer<typeof ImportWorkout>

export const ImportPlanSchema = z.object({
  replace: z.boolean().default(true),
  settings: SettingsSchema.partial().optional(),
  meals: z.array(ImportMeal).max(200).default([]),
  workouts: z.array(ImportWorkout).max(200).default([]),
})
export type ImportPlan = z.infer<typeof ImportPlanSchema>
export type ImportPlanInput = z.input<typeof ImportPlanSchema>

// ---------- Importar lançamentos do dia (JSON colado) ----------

export const ImportDaySchema = z.object({
  date: isoDate,
  meals: z
    .array(
      z.object({
        name: z.string().min(1).max(80),
        done: z.boolean().default(true),
        kcal: kcal.nullable().default(null),
        note: longText.default(''),
      }),
    )
    .max(30)
    .default([]),
  extras: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        kcal,
        time: hhmm.nullable().default(null),
        category: ExtraCategorySchema.default('outro'),
      }),
    )
    .max(30)
    .default([]),
  workouts: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        done: z.boolean().default(true),
        duration_min: z.number().int().min(0).max(1440).nullable().default(null),
        kcal: kcal.nullable().default(null),
        distance_km: z.number().min(0).max(1000).nullable().default(null),
        avg_hr: z.number().min(0).max(260).nullable().default(null),
        avg_pace: pace.nullable().default(null),
        note: longText.default(''),
      }),
    )
    .max(20)
    .default([]),
})
export type ImportDay = z.infer<typeof ImportDaySchema>

/** Junta as mensagens de erro do zod em português legível. */
export function formatZodError(err: z.ZodError): string {
  return err.issues
    .slice(0, 8)
    .map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`)
    .join('\n')
}
