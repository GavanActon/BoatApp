import { useState } from 'react'
import { useAppStore } from '../state/appStore'

/**
 * The welcome (DESIGN-SPEC §10.1): three cards before the chart, first
 * launch only. This is the one moment the app talks about itself — the
 * trust card leads, because "the lake's own models" is the sentence that
 * separates Sandies from every weather app already on the phone — and the
 * one surface exempt from §1.5's no-sentences rule. Finishing or skipping
 * is permanent; the first-voyage card (§10.2) is waiting underneath.
 */

const CARDS = [
  {
    glyph: '🍁',
    title: 'Forecasts made for this lake',
    body:
      "Wind from Environment Canada's 2.5 km model. Waves from the 1 km model run for Lake Superior, " +
      'four times a day — not a city pin from a global app. Every point on the chart is its own forecast, ' +
      'and the app always shows how fresh it is.',
  },
  {
    glyph: '📡',
    title: 'Charts with no bars required',
    body:
      'Real depths, satellite and buoys live on your phone. Out past the point the signal quits — ' +
      "the chart doesn't.",
  },
  {
    glyph: '🕘',
    title: 'Pick a place. Pick an hour.',
    body:
      'Tap anywhere on the water for depth, wind and waves. Tap an hour up top and the whole day plans ' +
      'around it — the run out, the ride home, the windows between.',
  },
]

export default function WelcomeCards() {
  const onboarded = useAppStore((s) => s.onboarded)
  const setOnboarded = useAppStore((s) => s.setOnboarded)
  const [i, setI] = useState(0)

  if (onboarded) return null
  const last = i === CARDS.length - 1
  const c = CARDS[i]

  return (
    <div className="welcome" role="dialog" aria-label="Welcome to Sandies">
      <button className="welcome-skip" onClick={() => setOnboarded(true)}>
        Skip
      </button>
      <div className="welcome-card">
        <div className="welcome-glyph" aria-hidden>
          {c.glyph}
        </div>
        <h2>{c.title}</h2>
        <p>{c.body}</p>
        <button
          className="welcome-next"
          onClick={() => (last ? setOnboarded(true) : setI(i + 1))}
        >
          {last ? 'Get set up' : 'Next'}
        </button>
        <div className="welcome-dots" aria-hidden>
          {CARDS.map((_, d) => (
            <span key={d} className={d === i ? 'on' : ''} />
          ))}
        </div>
      </div>
    </div>
  )
}
