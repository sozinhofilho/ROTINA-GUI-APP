// Camada de dados única usada pela API do app e pelo servidor MCP.
// load() devolve o mesmo AppData que o app usa; apply() grava as mesmas operações (Op) da fila do app.
import { applyOp } from '../../shared/logic.ts'
import type { Op } from '../../shared/schemas.ts'
import type { AppData } from '../../shared/types.ts'
import { applyOpDb } from './mutate.ts'
import { loadData } from './server.ts'

export interface Store {
  load(from: string, to: string): Promise<AppData>
  apply(ops: Op[]): Promise<void>
}

export const supabaseStore: Store = {
  load: loadData,
  async apply(ops) {
    for (const op of ops) await applyOpDb(op)
  },
}

/** Store em memória com a mesma semântica (applyOp), para testes. */
export function memoryStore(initial: AppData): Store & { data: AppData; writes: number } {
  const s = {
    data: structuredClone(initial),
    writes: 0,
    async load(from: string, to: string): Promise<AppData> {
      const inRange = (d: string) => d >= from && d <= to
      const d = s.data
      return structuredClone({
        ...d,
        overrides: d.overrides.filter((o) => inRange(o.from_date) || inRange(o.to_date)),
        meal_logs: d.meal_logs.filter((l) => inRange(l.date)),
        workout_logs: d.workout_logs.filter((l) => inRange(l.date)),
        extras: d.extras.filter((e) => inRange(e.date)),
      })
    },
    async apply(ops: Op[]): Promise<void> {
      for (const op of ops) {
        s.data = applyOp(s.data, op)
        s.writes++
      }
    },
  }
  return s
}
