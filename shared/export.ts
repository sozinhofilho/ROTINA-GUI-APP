// Monta as abas da planilha de exportação (usado pelo app e pelo link do MCP).
import { expandDay, mealKcal, summarize, workoutKcal } from './calc.ts'
import { addDays, dateRange, formatBR, weekStart } from './dates.ts'
import { review } from './review.ts'
import { weeklyBalance } from './balance.ts'
import type { AppData } from './types.ts'

const STATUS: Record<string, string> = { vazio: 'Sem registro', abaixo: 'Abaixo', dentro: 'Dentro', acima: 'Acima' }
const CATEGORY: Record<string, string> = { alcool: 'Álcool', lanche: 'Lanche', refeicao: 'Refeição fora', outro: 'Outro' }
const SOURCE: Record<string, string> = { manual: 'Manual', strava: 'Strava', import: 'Importado' }

export interface ExportSheet {
  name: string
  rows: Record<string, unknown>[]
}

/** SheetJS mínimo que usamos (o módulo 'xlsx' inteiro satisfaz). */
export interface XlsxLike {
  utils: {
    book_new(): unknown
    json_to_sheet(rows: Record<string, unknown>[]): Record<string, unknown>
    book_append_sheet(wb: unknown, ws: unknown, name: string): void
    sheet_to_csv(ws: unknown, opts?: { FS?: string }): string
  }
}

export function exportFileName(from: string, to: string, today: string, ext: string): string {
  return `rotina_${from}_a_${to < today ? to : today}.${ext}`
}

export function buildExportSheets(data: AppData, from: string, to: string, today: string): ExportSheet[] {
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
      'Registro de comida': s.hasRecord ? 'Sim' : 'Não',
      'Gasto basal': s.base ?? '',
      'Kcal treinos': s.kcalWorkouts,
      'Kcal treinos estimadas (sem valor real)': s.kcalWorkoutsEstimated,
      'Gasto total (basal + treinos)': s.base != null ? s.spent : '',
      'Saldo (consumido − gasto total)': s.balance ?? '',
      'Situação do saldo': s.balance == null ? (s.hasRecord ? '' : 'sem registro') : s.balance < 0 ? 'déficit' : s.balance > 0 ? 'superávit' : 'zerado',
      'Dia em andamento': v.date === today ? 'Sim' : '',
      'Água (L)': s.waterMl / 1000,
      'Meta de água': s.waterOk ? 'Sim' : 'Não',
      'Peso (kg)': s.weightKg ?? '',
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
      'Pace (min/km)': w.log?.avg_pace ?? '',
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
      const rv = review(ws < from ? from : ws, addDays(ws, 6), data, end)
      weekly.push({
        'Semana (seg)': formatBR(ws),
        'Assertividade (%)': rv.score ?? '',
        'Dias com meta de água': rv.pillars[3].done,
        'Peso no fim da semana (kg)': rv.weights.length ? rv.weights[rv.weights.length - 1].kg : '',
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

  const evolution = weeklyBalance(from, end, data, today).map((w) => ({
    'Semana (seg)': formatBR(w.weekStart),
    'Dias encerrados': w.closedDays,
    'Dias com registro': w.daysWithFood,
    'Dias sem registro': w.daysWithoutFood,
    'Consumo médio (kcal)': w.avgKcalIn ?? '',
    'Gasto basal': w.base ?? '',
    'Gasto total médio (kcal)': w.avgSpent ?? '',
    'Saldo médio/dia (kcal)': w.avgBalance ?? '',
    'Saldo acumulado (kcal)': w.totalBalance ?? '',
    'Gordura equivalente (kg, estimativa)': w.fatKg ?? '',
    'Dias em déficit': w.deficitDays,
    'Dias em superávit': w.surplusDays,
    'Treinos feitos': w.workoutsDone,
    'Treinos previstos': w.workoutsPlanned,
    'Treinos que faltaram': w.missedWorkouts.map((m) => `${m.name} (${formatBR(m.date)})`).join(', '),
    'Kcal em treino (total)': w.workoutKcalTotal,
    'Kcal em treino estimadas': w.workoutKcalEstimated,
    'Kcal em treino por dia': w.workoutKcalAvgPerDay,
  }))
  return [
    { name: 'Resumo diário', rows: daily },
    { name: 'Refeições', rows: meals },
    { name: 'Treinos', rows: workouts },
    { name: 'Extras', rows: extras },
    { name: 'Resumo semanal', rows: weekly },
    { name: 'Evolução', rows: evolution },
    {
      name: 'Peso',
      rows: (data.body ?? [])
        .filter((b) => b.date >= from && b.date <= end)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((b) => ({ Data: formatBR(b.date), 'Peso (kg)': b.weight_kg ?? '', 'Foto frente': b.photo_front ? 'Sim' : '', 'Foto lado': b.photo_side ? 'Sim' : '', Observação: b.note })),
    },
  ]
}

function toSheet(XLSX: XlsxLike, rows: Record<string, unknown>[]) {
  const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Info: 'Sem dados no período' }])
  const cols = Object.keys(rows[0] ?? { Info: '' })
  ws['!cols'] = cols.map((c) => ({ wch: Math.max(10, Math.min(40, c.length + 2)) }))
  return ws
}

export function buildWorkbook(XLSX: XlsxLike, sheets: ExportSheet[]): unknown {
  const wb = XLSX.utils.book_new()
  for (const s of sheets) XLSX.utils.book_append_sheet(wb, toSheet(XLSX, s.rows), s.name)
  return wb
}

/** CSV: uma seção por aba, separador ';' (abre direto no Excel em pt-BR). */
export function buildCsv(XLSX: XlsxLike, sheets: ExportSheet[]): string {
  return '\ufeff' + sheets.map((s) => `# ${s.name}\n${XLSX.utils.sheet_to_csv(toSheet(XLSX, s.rows), { FS: ';' })}`).join('\n\n')
}
