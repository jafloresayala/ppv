// src/utils/plants.tsx — plant code/name/flag/color constants and shared badge component

export const PLANT_NAMES: Record<string, string> = {
  '0010': 'Jasper',
  '0020': 'Mexico',
  '0040': 'Poland',
  '0045': 'Romania',
  '0050': 'Thailand',
  '0070': 'China',
}

export const PLANT_FLAGS: Record<string, string> = {
  '0010': '\uD83C\uDDFA\uD83C\uDDF8', // 🇺🇸
  '0020': '\uD83C\uDDF2\uD83C\uDDFD', // 🇲🇽
  '0040': '\uD83C\uDDF5\uD83C\uDDF1', // 🇵🇱
  '0045': '\uD83C\uDDF7\uD83C\uDDF4', // 🇷🇴
  '0050': '\uD83C\uDDF9\uD83C\uDDED', // 🇹🇭
  '0070': '\uD83C\uDDE8\uD83C\uDDF3', // 🇨🇳
}

/** Distinct color per plant for charts and legend. */
export const PLANT_COLORS: Record<string, string> = {
  '0010': '#06b6d4', // cyan    — USA / Jasper
  '0020': '#22c55e', // green   — Mexico
  '0040': '#ef4444', // red     — Poland
  '0045': '#d946ef', // fuchsia — Romania
  '0050': '#6366f1', // indigo  — Thailand
  '0070': '#f59e0b', // amber   — China
}

/** Maps PPV plant codes ('0020') → SAP site codes ('KEMX') used in EMS InternalQuery */
export const PPV_TO_SAP_SITE: Record<string, string> = {
  '0010': 'KEJ',
  '0020': 'KEMX',
  '0040': 'KEPS',
  '0045': 'KERO',
  '0050': 'KETL',
  '0070': 'KECN',
}

/** Display names for SAP site codes returned by EMS InternalQuery */
export const SAP_SITE_NAMES: Record<string, string> = {
  'KEJ':  'Jasper',
  'KEMX': 'Mexico',
  'KEPS': 'Poland',
  'KERO': 'Romania',
  'KETL': 'Thailand',
  'KECN': 'China',
  'KETA': 'Tampa',
}

/** Flag emoji for SAP site codes */
export const SAP_SITE_FLAGS: Record<string, string> = {
  'KEJ':  '\uD83C\uDDFA\uD83C\uDDF8', // 🇺🇸
  'KEMX': '\uD83C\uDDF2\uD83C\uDDFD', // 🇲🇽
  'KEPS': '\uD83C\uDDF5\uD83C\uDDF1', // 🇵🇱
  'KERO': '\uD83C\uDDF7\uD83C\uDDF4', // 🇷🇴
  'KETL': '\uD83C\uDDF9\uD83C\uDDED', // 🇹🇭
  'KECN': '\uD83C\uDDE8\uD83C\uDDF3', // 🇨🇳
  'KETA': '\uD83C\uDDFA\uD83C\uDDF8', // 🇺🇸
}

/** Short country labels used in headers and buttons. */
export const PLANT_SHORT: Record<string, string> = {
  '0010': 'USA',
  '0020': 'MX',
  '0040': 'POLAND',
  '0045': 'ROMANIA',
  '0050': 'THAILAND',
  '0070': 'CHINA',
}

/** Compact flag-only pill. Hovering shows code + full name. */
export function PlantBadge({ code }: { code: string }) {
  const flag = PLANT_FLAGS[code] ?? '\uD83C\uDFED'
  const name = PLANT_NAMES[code] ?? code
  return (
    <span
      title={`${code} \u2014 ${name}`}
      className="inline-flex items-center px-1 py-0.5 rounded text-sm leading-tight"
    >
      {flag}
    </span>
  )
}

/** Render a list of plant codes as compact flag pills. Returns null when empty. */
export function PlantBadges({ plants }: { plants?: string[] }) {
  if (!plants?.length) return null
  return (
    <span className="flex flex-wrap gap-0.5">
      {plants.map(p => <PlantBadge key={p} code={p} />)}
    </span>
  )
}
