// Exportação no app: mesma planilha que o link do MCP (shared/export.ts). SheetJS carregado sob demanda.
import { buildExportSheets, buildWorkbook, exportFileName } from '../../shared/export.ts'
import type { AppData } from '../../shared/types.ts'

export async function exportXlsx(data: AppData, from: string, to: string, today: string): Promise<void> {
  const XLSX = await import('xlsx')
  const wb = buildWorkbook(XLSX, buildExportSheets(data, from, to, today))
  XLSX.writeFile(wb as never, exportFileName(from, to, today, 'xlsx'))
}
