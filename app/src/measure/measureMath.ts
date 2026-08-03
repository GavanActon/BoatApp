import { haversineNm } from '../routing/waterRouter'
import type { DepthUnit } from '../state/appStore'
import { distanceUnitFor, nmToUnit, type SpeedUnit } from '../units'

/** Range-and-bearing maths for the measuring tool, and the one place its
 *  numbers get formatted — the map labels and the card read the same. */

const M_PER_NM = 1852
const FT_PER_M = 3.28084

/** Initial great-circle bearing a→b, degrees true (0–360). */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180
  const lat1 = a[1] * toRad
  const lat2 = b[1] * toRad
  const dLon = (b[0] - a[0]) * toRad
  const y = Math.sin(dLon) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)
  return (Math.atan2(y, x) / toRad + 360) % 360
}

export interface Leg {
  nm: number
  deg: number
}

export function legsOf(points: [number, number][]): Leg[] {
  const legs: Leg[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    legs.push({ nm: haversineNm(a[0], a[1], b[0], b[1]), deg: bearingDeg(a, b) })
  }
  return legs
}

export function totalNm(points: [number, number][]): number {
  let nm = 0
  for (let i = 1; i < points.length; i++) {
    nm += haversineNm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1])
  }
  return nm
}

/**
 * A range in the units the user reads: nm / km / mi, following the speed
 * preference. Close in it switches to metres or feet — at a boat length
 * "0.01 nm" tells you nothing — metric alongside km, feet alongside miles,
 * and the depth preference decides it for nautical miles.
 */
export function formatDistance(nm: number, speed: SpeedUnit, depth: DepthUnit): string {
  const unit = distanceUnitFor(speed)
  const v = nmToUnit(unit, nm)
  if (v < 0.15) {
    const small = unit === 'km' ? 'm' : unit === 'mi' ? 'ft' : depth
    const m = nm * M_PER_NM
    return small === 'ft' ? `${Math.round(m * FT_PER_M)} ft` : `${Math.round(m)} m`
  }
  return `${v < 10 ? v.toFixed(2) : v.toFixed(1)} ${unit}`
}

/** "042°T" — true, three digits, the way a course is written. */
export function formatBearing(deg: number): string {
  return `${String(Math.round(deg) % 360).padStart(3, '0')}°T`
}
