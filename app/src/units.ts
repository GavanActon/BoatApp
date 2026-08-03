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

/** Distances are stored in nautical miles everywhere, like speeds in knots. */
export type DistanceUnit = 'nm' | 'km' | 'mi'

/** A speed preference already says which distance the user thinks in: knots
 *  go with nautical miles, km/h with kilometres, mph with statute miles. */
export function distanceUnitFor(speed: SpeedUnit): DistanceUnit {
  return speed === 'kmh' ? 'km' : speed === 'mph' ? 'mi' : 'nm'
}

const NM_TO = { nm: 1, km: 1.852, mi: 1.15078 }

export function nmToUnit(unit: DistanceUnit, nm: number): number {
  return nm * NM_TO[unit]
}
