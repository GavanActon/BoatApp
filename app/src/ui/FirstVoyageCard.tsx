import { useEffect } from 'react'
import { DESTINATIONS } from '../config'
import { useAppStore } from '../state/appStore'
import { usePlacesStore } from '../state/placesStore'
import { useRouteStore } from '../routing/routeStore'
import { useGpsStore } from '../tracking/gpsStore'
import { locateAndFollow } from '../tracking/gpsService'
import { IconClose } from './icons'

/**
 * The first-voyage card (DESIGN-SPEC §10.2): setup as the dock's first
 * subject. Four rows, each a real action — location asks the OS, home arms
 * the chart for the pick (§10.3), the Sandies row plots the first run
 * (§10.4), the water row opens the numbers guide. Offline charts are
 * deliberately NOT here: downloading is a choice the Offline tab sells on
 * its own. All four observed done at once → setupDone, and the card
 * retires for good; the ✕ covers the borrowed-phone case.
 */

export default function FirstVoyageCard() {
  const setupDone = useAppStore((s) => s.setupDone)
  const setSetupDone = useAppStore((s) => s.setSetupDone)
  const pickingHome = useAppStore((s) => s.pickingHome)
  const setPickingHome = useAppStore((s) => s.setPickingHome)
  const firstRouteDone = useAppStore((s) => s.firstRouteDone)
  const numbersSeen = useAppStore((s) => s.numbersSeen)
  const gpsStatus = useGpsStore((s) => s.status)
  const homeName = usePlacesStore((s) => s.homeName)

  const locDone = gpsStatus === 'on'
  const homeDone = homeName != null
  const doneCount = Number(locDone) + Number(homeDone) + Number(firstRouteDone) + Number(numbersSeen)

  // all four seen in place at once — the card has done its job forever
  useEffect(() => {
    if (!setupDone && locDone && homeDone && firstRouteDone && numbersSeen) setSetupDone(true)
  }, [setupDone, locDone, homeDone, firstRouteDone, numbersSeen, setSetupDone])

  if (setupDone) return null
  // while the pick is armed the chart needs the room — the banner up top
  // (TopBar) is carrying the instruction
  if (pickingHome) return null

  // the same run the Places route button plots (§0.4: a fresh subject
  // starts at exploring) — the card yields to the trip card it summons
  const routeToSandies = () => {
    const d = DESTINATIONS.find((x) => x.name === 'The Sandies') ?? DESTINATIONS[0]
    if (!d) return
    useAppStore.getState().setFirstRouteDone(true)
    useAppStore.getState().setPlanPicked(false)
    const rs = useRouteStore.getState()
    rs.setDestination({ name: d.name, lon: d.lon, lat: d.lat })
    rs.setFocusPoint({ lon: d.lon, lat: d.lat, label: d.name })
    rs.setCard('trip')
    useAppStore.getState().setDetent('rest')
    useAppStore.getState().setSheetTab(null)
  }

  return (
    <div className="fv glass">
      <div className="fv-head">
        <div>
          <div className="fv-title">Get set for the water</div>
          <div className="fv-sub">Four taps and you're reading the lake</div>
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

      {/* the guide comes BEFORE the first route: learn the numbers, then
          watch them draw the run */}
      <button
        className={`fv-row ${numbersSeen ? 'done' : ''}`}
        onClick={() => useAppStore.getState().setShowNumbersGuide(true)}
      >
        <span className="fv-box">{numbersSeen ? '✓' : ''}</span>
        <span className="fv-text">
          <b>Read the water</b>
          <i>What every number and colour means</i>
        </span>
      </button>

      <button
        className={`fv-row ${firstRouteDone ? 'done' : ''}`}
        onClick={() => !firstRouteDone && routeToSandies()}
      >
        <span className="fv-box">{firstRouteDone ? '✓' : ''}</span>
        <span className="fv-text">
          <b>Route to The Sandies</b>
          <i>Your first run — lanes, times, the ride home</i>
        </span>
      </button>

      <div className="fv-prog" aria-hidden>
        <i style={{ width: `${(doneCount / 4) * 100}%` }} />
      </div>
    </div>
  )
}
