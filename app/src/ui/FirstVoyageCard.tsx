import { useEffect } from 'react'
import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useGpsStore } from '../tracking/gpsStore'
import { locateAndFollow } from '../tracking/gpsService'
import { IconClose } from './icons'

/**
 * The first-voyage card (DESIGN-SPEC §10.2): setup as the dock's first
 * subject. Three rows, each a real action — location asks the OS, charts
 * opens Offline, home arms the chart for the pick (§10.3). All three
 * observed done at once → setupDone, and the card retires for good; the ✕
 * covers the borrowed-phone case. Rows echo the checklist grammar the rest
 * of the app uses; the why-lines stay fragments.
 */

export default function FirstVoyageCard() {
  const setupDone = useAppStore((s) => s.setupDone)
  const setSetupDone = useAppStore((s) => s.setSetupDone)
  const pickingHome = useAppStore((s) => s.pickingHome)
  const setPickingHome = useAppStore((s) => s.setPickingHome)
  const offlineReady = useAppStore((s) => s.offlineReady)
  const gpsStatus = useGpsStore((s) => s.status)
  const homeName = usePlacesStore((s) => s.homeName)

  const locDone = gpsStatus === 'on'
  const homeDone = homeName != null
  const doneCount = Number(locDone) + Number(offlineReady) + Number(homeDone)

  // all three seen in place at once — the card has done its job forever
  useEffect(() => {
    if (!setupDone && locDone && offlineReady && homeDone) setSetupDone(true)
  }, [setupDone, locDone, offlineReady, homeDone, setSetupDone])

  if (setupDone) return null
  // while the pick is armed the chart needs the room — the banner up top
  // (TopBar) is carrying the instruction
  if (pickingHome) return null

  return (
    <div className="fv glass">
      <div className="fv-head">
        <div>
          <div className="fv-title">Get set for the water</div>
          <div className="fv-sub">Three taps and Sandies is fully aboard</div>
        </div>
        <button className="fv-close" aria-label="Dismiss setup" onClick={() => setSetupDone(true)}>
          <IconClose size={16} />
        </button>
      </div>

      <button className={`fv-row ${locDone ? 'done' : ''}`} onClick={() => !locDone && locateAndFollow()}>
        <span className="fv-box">{locDone ? '✓' : ''}</span>
        <span className="fv-text">
          <b>Allow location</b>
          <i>The chart follows the boat</i>
        </span>
      </button>

      <button
        className={`fv-row ${offlineReady ? 'done' : ''}`}
        onClick={() => !offlineReady && useAppStore.getState().setSheetTab('offline')}
      >
        <span className="fv-box">{offlineReady ? '✓' : ''}</span>
        <span className="fv-text">
          <b>Bring the charts aboard</b>
          <i>One download — then no signal needed</i>
        </span>
      </button>

      <button
        className={`fv-row ${homeDone ? 'done' : ''}`}
        onClick={() => {
          if (homeDone) return
          // the chart is the keypad: sheet away, pick armed (§10.3)
          useAppStore.getState().setSheetTab(null)
          setPickingHome(true)
        }}
      >
        <span className="fv-box">{homeDone ? '★' : ''}</span>
        <span className="fv-text">
          <b>Star your home dock</b>
          <i>Tap it on the chart — trips plan the ride home</i>
        </span>
      </button>

      <div className="fv-prog" aria-hidden>
        <i style={{ width: `${(doneCount / 3) * 100}%` }} />
      </div>
    </div>
  )
}
