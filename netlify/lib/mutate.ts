// Aplica operações validadas no banco. Mesmo significado de applyOp() em shared/logic.ts.
import type { Op } from '../../shared/schemas.ts'
import { db, must } from './server.ts'

const now = () => new Date().toISOString()

export async function applyOpDb(op: Op): Promise<void> {
  const s = db()
  switch (op.t) {
    case 'meal_log.upsert': {
      const row = { ...op.row, updated_at: now() }
      if (row.plan_meal_id) {
        // Um registro por refeição planejada por dia, mesmo se o id local for outro.
        must(await s.from('meal_logs').upsert(row, { onConflict: 'date,plan_meal_id' }))
      } else {
        must(await s.from('meal_logs').upsert(row, { onConflict: 'id' }))
      }
      return
    }
    case 'meal_log.delete':
      must(await s.from('meal_logs').delete().eq('id', op.id))
      return
    case 'workout_log.upsert': {
      const row = { ...op.row, updated_at: now() }
      if (row.plan_workout_id) {
        // Se já existe outro registro para este treino/dia (ex.: veio do Strava), preserva os dados dele.
        const existing = must(
          await s.from('workout_logs').select('id, source, strava_activity_id')
            .eq('date', row.date).eq('plan_workout_id', row.plan_workout_id).maybeSingle(),
        ) as { id: string; source: string; strava_activity_id: number | null } | null
        if (existing && existing.id !== row.id) {
          row.id = existing.id
          if (existing.source === 'strava') {
            row.source = 'strava'
            row.strava_activity_id = existing.strava_activity_id
          }
        }
        must(await s.from('workout_logs').upsert(row, { onConflict: 'id' }))
      } else {
        must(await s.from('workout_logs').upsert(row, { onConflict: 'id' }))
      }
      return
    }
    case 'workout_log.delete':
      must(await s.from('workout_logs').delete().eq('id', op.id))
      return
    case 'workout_log.assign': {
      const log = must(await s.from('workout_logs').select('id, date, name').eq('id', op.id).maybeSingle()) as
        | { id: string; date: string; name: string }
        | null
      if (!log) return
      let name = log.name
      if (op.plan_workout_id) {
        // Remove um eventual check manual do mesmo treino/dia: a atividade passa a cumpri-lo.
        must(
          await s.from('workout_logs').delete()
            .eq('date', log.date).eq('plan_workout_id', op.plan_workout_id).neq('id', op.id),
        )
        const plan = must(await s.from('plan_workouts').select('name').eq('id', op.plan_workout_id).maybeSingle()) as
          | { name: string }
          | null
        if (plan) name = plan.name
      }
      must(
        await s.from('workout_logs')
          .update({ plan_workout_id: op.plan_workout_id, name, done: true, updated_at: now() })
          .eq('id', op.id),
      )
      return
    }
    case 'extra.upsert':
      must(await s.from('extra_entries').upsert(op.row, { onConflict: 'id' }))
      return
    case 'extra.delete':
      must(await s.from('extra_entries').delete().eq('id', op.id))
      return
    case 'override.upsert':
      must(
        await s.from('day_overrides').delete()
          .eq('plan_workout_id', op.row.plan_workout_id).eq('from_date', op.row.from_date).neq('id', op.row.id),
      )
      must(await s.from('day_overrides').upsert(op.row, { onConflict: 'id' }))
      return
    case 'override.delete':
      must(await s.from('day_overrides').delete().eq('id', op.id))
      return
    case 'plan_meal.upsert':
      must(await s.from('plan_meals').upsert({ ...op.row, updated_at: now() }, { onConflict: 'id' }))
      return
    case 'plan_meal.delete':
      must(await s.from('plan_meals').delete().eq('id', op.id))
      return
    case 'plan_workout.upsert':
      must(await s.from('plan_workouts').upsert({ ...op.row, updated_at: now() }, { onConflict: 'id' }))
      return
    case 'plan_workout.delete':
      must(await s.from('plan_workouts').delete().eq('id', op.id))
      return
    case 'settings.update':
      must(await s.from('settings').update({ ...op.row, updated_at: now() }).eq('id', 1))
      return
  }
}
