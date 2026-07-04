import type { FeatureCollection } from 'geojson'
import { CONTOURS_FILE, DATA_BASE } from '../config'
import { getStoredFile } from '../offline/fileStore'

/** Load the contour/sounding GeoJSON — local copy first, network otherwise. */
export async function loadContours(): Promise<FeatureCollection | null> {
  try {
    const blob = await getStoredFile(CONTOURS_FILE)
    if (blob) return JSON.parse(await blob.text()) as FeatureCollection
    const resp = await fetch(DATA_BASE + CONTOURS_FILE)
    if (!resp.ok) return null
    return (await resp.json()) as FeatureCollection
  } catch {
    return null
  }
}
