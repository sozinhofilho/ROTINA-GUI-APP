// Exporta tudo para .xlsx com SheetJS (carregado só quando usado).
import { expandDay, mealKcal, summarize, workoutKcal } from '../../shared/calc.ts'
import { addDays, dateRange, formatBR, weekStart } from '../../shared/dates.ts'
import type { AppData } from '../../shared/types.ts'

const STATUS: Record<string, string> = { vazio: 'Sem registro', abaixo: 'Abaixo', dentro: 'Dentro', acima: 'Acima' }
const CATEGORY: Record<string, string> = { alcool: 'Álcool', lanche: 'Lanche', refeicao: 'Refeição fora', outro: 'Outro' }
const SOURCE: Record<string, string> = { manual: 'Manual', strava: 'Strava', import: 'Importado' }

export async function exportXlsx(data: AppData, from: string, to: string, today: string): Promise<void> {
  const XLSX = await import('xlsx')
  const end = to < today ? to : today
  const days = from <= end ? dateRange(from, end) : []
  const views = days.map((d) => expandDay(d, data))

  const daily = views.map((v) => {
    const s = v.stats
    return {
      Data: formatBR(v.date),
      'Kcal ingeridas': s.kcalIn,
      'Kcal extras': s.kcalExtras,
      Meta: s.goal,
      'Mín (meta − tol.)': s.min,
      'Máx (meta + tol.)': s.max,
      Situação: STATUS[s.status],
      'Dentro da meta': s.inGoal ? 'Sim' : 'Não',
      'Refeições feitas': s.mealsDone,
      'Refeições previstas': s.mealsTotal,
      'Treinos feitos': s.workoutsDone,
      'Treinos previstos': s.workoutsPlanned,
      'Kcal treinos': s.kcalWorkouts,
      'Gasto base': s.base ?? '',
      'Gasto total': s.spent,
      Saldo: s.balance ?? '',
    }
  })

  const meals = views.flatMap((v) =>
    v.meals.map((m) => ({
      Data: formatBR(v.date),
      Horário: m.time ?? '',
      Refeição: m.name,
      Feita: m.log?.done ? 'Sim' : 'Não',
      'Kcal previstas': m.plan?.kcal ?? m.log?.kcal_planned ?? '',
      'Kcal reais': m.log?.kcal_real ?? '',
      'Kcal contadas': m.log?.done ? mealKcal(m.log, m.plan) : 0,
      'Proteína (g)': m.plan?.protein ?? '',
      'Carbo (g)': m.plan?.carbs ?? '',
      'Gordura (g)': m.plan?.fat ?? '',
      'Estimativa IA (kcal)': m.log?.ai_estimate?.kcal ?? '',
      Observação: m.log?.note ?? '',
      Foto: m.log?.photo_path ? 'Sim' : '',
    })),
  )

  const workouts = views.flatMap((v) =>
    v.workouts.map((w) => ({
      Data: formatBR(v.date),
      Treino: w.log?.name || w.name,
      Feito: w.log?.done ? 'Sim' : 'Não',
      'Previsto no plano': w.plan ? 'Sim' : 'Não',
      'Trocado de': w.movedFrom ? formatBR(w.movedFrom.from_date) : '',
      'Duração (min)': w.log?.duration_min ?? w.plan?.duration_min ?? '',
      Kcal: w.log?.done ? workoutKcal(w.log, w.plan) : '',
      'Distância (km)': w.log?.distance_m != null ? Math.round(w.log.distance_m / 10) / 100 : '',
      'FC média': w.log?.avg_hr ?? '',
      Origem: w.log ? SOURCE[w.log.source] : '',
      Observação: w.log?.note ?? '',
    })),
  )

  const extras = views.flatMap((v) =>
    v.extras.map((e) => ({
      Data: formatBR(v.date),
      Horário: e.time ?? '',
      Descrição: e.description,
      Categoria: CATEGORY[e.category],
      Kcal: e.kcal,
    })),
  )

  const weekly: Record<string, unknown>[] = []
  if (days.length) {
    for (let ws = weekStart(days[0]); ws <= end; ws = addDays(ws, 7)) {
      const s = summarize(ws < from ? from : ws, addDays(ws, 6), data, end)
      weekly.push({
        'Semana (seg)': formatBR(ws),
        Dias: s.days,
        'Dias com registro': s.daysWithRecord,
        'Dias na meta': s.daysInGoal,
        'Média kcal ingeridas': s.avgKcalIn,
        'Média gasto': s.avgSpent,
        'Refeições feitas (%)': s.pctMeals,
        'Treinos feitos': s.workoutsDone,
        'Treinos previstos feitos (%)': s.pctWorkouts,
        'Melhor sequência na meta': s.bestStreak,
      })
    }
  }

  const wb = XLSX.utils.book_new()
  const add = (name: string, rows: Record<string, unknown>[]) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Info: 'Sem dados no período' }])
    const cols = Object.keys(rows[0] ?? { Info: '' })
    ws['!cols'] = cols.map((c) => ({ wch: Math.max(10, Math.min(40, c.length + 2)) }))
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  add('Resumo diário', daily)
  add('Refeições', meals)
  add('Treinos', workouts)
  add('Extras', extras)
  add('Resumo semanal', weekly)
  XLSX.writeFile(wb, `rotina_${from}_a_${end}.xlsx`)
}
