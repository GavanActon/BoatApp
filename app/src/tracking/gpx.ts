import { db, type Track } from './db'

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export async function trackToGpx(track: Track): Promise<string> {
  const pts = await db.points.where('trackId').equals(track.id!).sortBy('ts')
  const seg = pts
    .map((p) => {
      const t = new Date(p.ts).toISOString()
      return `      <trkpt lat="${p.lat.toFixed(7)}" lon="${p.lon.toFixed(7)}"><time>${t}</time></trkpt>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Sandies" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${esc(track.name)}</name>
    <trkseg>
${seg}
    </trkseg>
  </trk>
</gpx>
`
}

/** Share (iOS share sheet) or download a track as GPX. */
export async function exportTrackGpx(track: Track): Promise<void> {
  const gpx = await trackToGpx(track)
  const fileName = `${track.name.replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-')}.gpx`
  const file = new File([gpx], fileName, { type: 'application/gpx+xml' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: track.name })
      return
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return
      // fall through to download
    }
  }
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
