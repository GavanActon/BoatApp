import { CONTOURS_FILE, DATA_BASE } from '../config'
import { getStoredFile } from '../offline/fileStore'

/**
 * Where the contour/sounding GeoJSON lives, as a URL the map's own source
 * can load: the local copy (an object URL over the stored blob) first, the
 * network otherwise.
 *
 * The 2.4 MB file used to be fetched, parsed on the main thread and handed
 * to the style as an object BEFORE the map was even built — so the chart
 * waited on the contours, and their parse was a long task in the middle of
 * the boot. Given as a URL, the source loads it itself once the map exists:
 * from the network the worker fetches and parses it off the main thread
 * entirely; from a stored blob MapLibre reads it on the main thread but
 * after the chart is already drawing.
 */
export async function contoursUrl(): Promise<string | null> {
  try {
    const blob = await getStoredFile(CONTOURS_FILE)
    if (blob) return URL.createObjectURL(blob)
    return new URL(DATA_BASE + CONTOURS_FILE, window.location.href).toString()
  } catch {
    return null
  }
}
