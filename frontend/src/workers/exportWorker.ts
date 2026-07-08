// src/workers/exportWorker.ts
// Builds the exported .xlsx workbook (ExcelJS workbook assembly + zip
// compression) entirely off the main thread. This is the CPU-heavy part of
// "Export Excel" — for large datasets it can take seconds, and doing it on
// the main thread freezes the whole page (and can trigger the browser's
// "page unresponsive" prompt). By the time a request reaches this worker,
// all row data is already plain, serializable values — no functions/closures
// are ever sent here.
import ExcelJS from 'exceljs'

// The DOM lib (used by the rest of the app) and the webworker lib can't both
// be active in the same TS program, so `self` is re-declared loosely here
// just for this file's type-checking purposes.
declare const self: {
  onmessage: ((e: MessageEvent<ExportRequest>) => void) | null
  postMessage: (msg: ExportResponse) => void
}

export interface ExportColumnMeta {
  key: string
  header: string
  width: number
  numberFormat?: string
}

export interface ExportRowData {
  values: Record<string, string | number | null>
  fills?: Record<string, string | null | undefined>
  fontColors?: Record<string, string | null | undefined>
}

export interface ExportRequest {
  sheetName: string
  fileName: string
  columns: ExportColumnMeta[]
  rows: ExportRowData[]
}

export type ExportResponse =
  | { type: 'done'; fileName: string; buffer: ArrayBuffer }
  | { type: 'error'; message: string }

self.onmessage = async (e: MessageEvent<ExportRequest>) => {
  const { sheetName, fileName, columns, rows } = e.data
  try {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet(sheetName.slice(0, 31) || 'Data')
    ws.columns = columns.map(c => ({ header: c.header, key: c.key, width: c.width }))

    for (const r of rows) {
      const excelRow = ws.addRow(r.values)
      columns.forEach((c, idx) => {
        const fill = r.fills?.[c.key]
        const fontColor = r.fontColors?.[c.key]
        if (!c.numberFormat && !fill && !fontColor) return
        const cell = excelRow.getCell(idx + 1)
        if (c.numberFormat) cell.numFmt = c.numberFormat
        if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } }
        if (fontColor) cell.font = { ...(cell.font ?? {}), color: { argb: fontColor } }
      })
    }

    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2563EB' } }
    ws.getRow(1).alignment = { vertical: 'middle' }
    ws.views = [{ state: 'frozen', ySplit: 1 }]
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }

    const buffer = await wb.xlsx.writeBuffer()
    self.postMessage({ type: 'done', fileName, buffer: buffer as ArrayBuffer })
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
  }
}
