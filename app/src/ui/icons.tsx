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

export const IconRefresh = (p: IconProps) => (
  <svg width={S(p)} height={S(p)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 12a8 8 0 1 1-2.34-5.66" />
    <path d="M20 3v4h-4" />
  </svg>
)
