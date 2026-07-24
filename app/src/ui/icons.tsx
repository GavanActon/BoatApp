interface IconProps {
  size?: number
}

const S = (p: IconProps) => p.size ?? 22

export const IconLocate = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="7.5" />
    <path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3" strokeLinecap="round" />
  </svg>
)

export const IconCompass = (p: IconProps & { rotation?: number }) => (
  <svg
    width={S(p)}
    height={S(p)}
    viewBox="0 0 24 24"
    style={{ transform: `rotate(${p.rotation ?? 0}deg)`, transition: 'transform 0.2s' }}
  >
    <path d="M12 2 L15.5 12 L12 22 L8.5 12 Z" fill="none" stroke="currentColor" strokeWidth="1.6" />
    <path d="M12 2 L15.5 12 L8.5 12 Z" fill="#ff6b6b" stroke="none" />
  </svg>
)

export const IconLayers = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
    <path d="M12 3 L21 8 L12 13 L3 8 Z" />
    <path d="M4.5 12.5 L12 16.5 L19.5 12.5" strokeLinecap="round" />
    <path d="M4.5 16.5 L12 20.5 L19.5 16.5" strokeLinecap="round" opacity="0.55" />
  </svg>
)

export const IconWind = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M3 8h9.5a2.8 2.8 0 1 0-2.6-3.8" />
    <path d="M3 13h14.5a2.8 2.8 0 1 1-2.6 3.8" />
    <path d="M3 18h7" opacity="0.6" />
  </svg>
)

export const IconTrack = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <circle cx="5" cy="19" r="2.2" />
    <circle cx="19" cy="5" r="2.2" />
    <path d="M6.5 17.5 C 10 14, 9 10, 12 8.5 C 14.5 7.2, 15.5 8, 17.3 6.6" strokeDasharray="0.1 3.2" />
  </svg>
)

export const IconRoute = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="5" cy="19" r="2.2" />
    <path d="M7 17.5 C 11 14.5, 8 10, 12.5 8 L 15 6.9" strokeDasharray="0.1 3.2" />
    <path d="M17.5 2.5 v9" />
    <path d="M17.5 3 h4 l-1.4 2 1.4 2 h-4" fill="currentColor" stroke="none" />
  </svg>
)

export const IconStar = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M12 2.5 L14.8 8.9 L21.5 9.6 L16.5 14.2 L18 21 L12 17.5 L6 21 L7.5 14.2 L2.5 9.6 L9.2 8.9 Z" />
  </svg>
)

export const IconMinus = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M5 12h14" />
  </svg>
)

export const IconPlus = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconPin = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 21.5 C 12 21.5, 5 14.8, 5 9.8 A 7 7 0 0 1 19 9.8 C 19 14.8, 12 21.5, 12 21.5 Z" />
    <circle cx="12" cy="9.8" r="2.6" />
  </svg>
)

export const IconDownload = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5" />
    <path d="M4 19.5h16" />
  </svg>
)

export const IconShare = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3v12" />
    <path d="M8 6.5 12 3l4 3.5" />
    <path d="M6 11H5a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 5 21h14a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 19 11h-1" />
  </svg>
)

export const IconTrash = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 6.5h16M9.5 6V4.5A1.5 1.5 0 0 1 11 3h2a1.5 1.5 0 0 1 1.5 1.5V6M6.5 6.5l1 13A1.5 1.5 0 0 0 9 21h6a1.5 1.5 0 0 0 1.5-1.5l1-13" />
  </svg>
)

export const IconClose = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
)

export const IconCheck = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 12.5 10 18 19.5 7" />
  </svg>
)

/** Arrow pointing where the wind blows toward (pass Open-Meteo "from" dir + 180). */
export const IconWindArrow = (p: IconProps & { deg: number }) => (
  <svg
    width={S(p)}
    height={S(p)}
    viewBox="0 0 14 14"
    style={{ transform: `rotate(${p.deg}deg)`, flexShrink: 0 }}
  >
    <path d="M7 1.5 L10 10 L7 8 L4 10 Z" fill="currentColor" />
  </svg>
)

// cloud outline shared by the sky glyphs; the raised variant leaves room for precipitation
const CLOUD = 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'
const CLOUD_HI = 'M18 7.5h-1.1A7 7 0 1 0 9.1 16.3H18a4.4 4.4 0 0 0 0-8.8z'

/** Sky glyph for an Open-Meteo weather code — pairs with skyLabel(). */
export const IconSky = (p: IconProps & { code: number }) => {
  const c = p.code
  const kind =
    c >= 95
      ? 'thunder'
      : (c >= 71 && c <= 77) || c === 85 || c === 86
        ? 'snow'
        : (c >= 51 && c <= 67) || (c >= 80 && c <= 82)
          ? 'rain'
          : c === 45 || c === 48
            ? 'fog'
            : c === 3
              ? 'cloud'
              : c === 2
                ? 'suncloud'
                : 'sun'
  return (
    <svg
      width={S(p)}
      height={S(p)}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {kind === 'sun' && (
        <>
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
        </>
      )}
      {kind === 'suncloud' && (
        <>
          <circle cx="7.5" cy="7.5" r="3" />
          <path d="M7.5 1.8v1.7M1.8 7.5h1.7M3.5 3.5l1.2 1.2M11.5 3.5l-1.2 1.2" />
          <path d="M18.5 20.5a3.8 3.8 0 0 0 0-7.6h-.95A6 6 0 1 0 11 20.5z" />
        </>
      )}
      {kind === 'cloud' && <path d={CLOUD} />}
      {kind === 'fog' && <path d="M4 8.5h16M4 13h16M7 17.5h10" />}
      {kind === 'rain' && (
        <>
          <path d={CLOUD_HI} />
          <path d="M8.7 19.3l-1 2.4M13 19.3l-1 2.4M17.3 19.3l-1 2.4" />
        </>
      )}
      {kind === 'snow' && (
        <>
          <path d={CLOUD_HI} />
          <path d="M8.5 20.3h.01M12.7 20.3h.01M16.9 20.3h.01" strokeWidth="2.6" />
        </>
      )}
      {kind === 'thunder' && (
        <>
          <path d={CLOUD_HI} />
          <path d="M13.4 16.2l-2.4 4h2.1l-1.2 3.6 3.9-5h-2.2z" fill="currentColor" stroke="none" />
        </>
      )}
    </svg>
  )
}

export const IconRefresh = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 3v4h-4" />
  </svg>
)
