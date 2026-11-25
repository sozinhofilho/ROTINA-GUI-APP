// Tipos compartilhados entre o front (src/) e as Netlify Functions.
// Dia da semana: 0 = domingo ... 6 = sábado (igual a Date.getUTCDay()).

export type WorkoutKind = 'hyrox' | 'run' | 'strength' | 'other'
export type ExtraCategory = 'alcool' | 'lanche' | 'refeicao' | 'outro'
export type WorkoutSource = 'manual' | 'strava' | 'import'

export interface Settings {
  calorie_goal: number
  tolerance_pct: number
  base_expenditure: number | null
  timezone: string
}

export interface MealItem {
  food: string
  qty: string
  kcal: number | null
}

export interface PlanMeal {
  id: string
  weekday: number
  name: string
  time: string // HH:MM
  description: string
  items: MealItem[]
  kcal: number
  protein: number | null
  carbs: number | null
  fat: number | null
  sort: number
}

export interface Exercise {
  name: string
  sets: string
  reps: string
}

export interface PlanWorkout {
  id: string
  weekday: number
  name: string
  kind: WorkoutKind
  time: string | null
  details: string
  exercises: Exercise[]
  duration_min: number | null
  kcal: number | null
  sort: number
}

export interface DayOverride {
  id: string
  plan_workout_id: string
  from_date: string
  to_date: string
}

export interface MealLog {
  id: string
  date: string
  plan_meal_id: string | null
  meal_name: string
  done: boolean
  kcal_planned: number | null
  kcal_real: number | null
  note: string
  photo_path: string | null
  ai_estimate: AiEstimate | null
}

export interface AiEstimate {
  kcal: number
  protein: number | null
  carbs: number | null
  fat: number | null
  description: string
  model: string
}

export interface WorkoutLog {
  id: string
  date: string
  plan_workout_id: string | null
  name: string
  done: boolean
  duration_min: number | null
  kcal: number | null
  distance_m: number | null
  avg_hr: number | null
  note: string
  source: WorkoutSource
  strava_activity_id: number | null
}

export interface ExtraEntry {
  id: string
  date: string
  time: string | null
  description: string
  kcal: number
  category: ExtraCategory
}

export interface AppData {
  settings: Settings
  plan_meals: PlanMeal[]
  plan_workouts: PlanWorkout[]
  overrides: DayOverride[]
  meal_logs: MealLog[]
  workout_logs: WorkoutLog[]
  extras: ExtraEntry[]
}

export interface DataResponse extends AppData {
  photo_urls: Record<string, string>
  features: { photo_ai: boolean; strava_configured: boolean; strava_connected: boolean }
}

export const DEFAULT_SETTINGS: Settings = {
  calorie_goal: 2500,
  tolerance_pct: 10,
  base_expenditure: null,
  timezone: 'America/Sao_Paulo',
}
