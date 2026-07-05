/** Boat-speed unit preference. Speeds are stored in knots everywhere;
 *  conversion happens only at the display edge. */

export type SpeedUnit = 'kn' | 'kmh' | 'mph'

export const SPEED_UNITS: { id: SpeedUnit; label: string }[] = [
  { id: 'kn', label: 'kn' },
  { id: 'kmh', label: 'km/h' },
  { id: 'mph', label: 'mph' },
]

const KN_TO = { kn: 1, kmh: 1.852, mph: 1.15078 }

export function knToUnit(unit: SpeedUnit, kn: number): number {
  return kn * KN_TO[unit]
}

export function unitToKn(unit: SpeedUnit, v: number): number {
  return v / KN_TO[unit]
}

export function speedUnitLabel(unit: SpeedUnit): string {
  return SPEED_UNITS.find((u) => u.id === unit)!.label
}
