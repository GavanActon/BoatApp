import { useAppStore } from '../state/appStore'
import { useDiscoverStore } from '../discover/store'

/**
 * The welcome (DESIGN-SPEC §10.1): ONE card before the chart, first launch
 * only. This is the one moment the app talks about itself — "the lake's own
 * models" is the sentence that separates Sandies from every weather app
 * already on the phone — and the one surface exempt from §1.5's
 * no-sentences rule. It used to be three cards; the second and third were
 * the ones a person in town skipped, and the pitch they carried lives on as
 * the chapters' reward lines in Discover.
 *
 * One answer, and the chart is yours: nothing else opens. The glyph on
 * the top bar wears its warning dot and a "Set up · 4 left" chip until
 * Discover is opened once — the asking is done by the chart's chrome, on
 * the person's own time, never by a sheet over the bays. The card never
 * shows again.
 */
export default function WelcomeCards() {
  const onboarded = useAppStore((s) => s.onboarded)
  const setOnboarded = useAppStore((s) => s.setOnboarded)

  if (onboarded) return null

  const go = () => {
    setOnboarded(true)
    useDiscoverStore.getState().setNudge(true)
  }

  return (
    <div className="welcome" role="dialog" aria-label="Welcome to Sandies">
      <div className="welcome-card">
        <div className="welcome-glyph" aria-hidden>
          🍁
        </div>
        <h2>Forecasts made for this lake</h2>
        <p>
          Wind from Environment Canada's 2.5 km model, waves from the 1 km model run for Lake Superior —
          not a city pin from a global app. Real depths and satellite on the phone, so the chart keeps
          working when the signal quits.
        </p>
        <button className="welcome-next" onClick={go}>
          Open the chart
        </button>
      </div>
    </div>
  )
}
