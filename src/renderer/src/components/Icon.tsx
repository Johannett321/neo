export type IconName = keyof typeof PATHS

/**
 * A small hand-rolled set on a 24px grid with a single stroke weight. One visual
 * language for every glyph in the app, and nothing to fetch at runtime.
 */
const PATHS = {
  today: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  projects: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  people: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 7.5a3 3 0 11-6 0 3 3 0 016 0zM21 19v-1a4 4 0 00-3-3.87M16.5 4.6a3 3 0 010 5.8',
  timeline: 'M8 3v4M16 3v4M3.5 9.5h17M4 7a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V7z',
  review: 'M9 12.5l2.2 2.2L15.5 10M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  settings: 'M4 7h10M18 7h2M4 12h2M10 12h10M4 17h8M16 17h4M16 5v4M8 10v4M14 15v4',
  search: 'M20.5 20.5l-4.2-4.2M18 11a7 7 0 11-14 0 7 7 0 0114 0z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  chevronRight: 'M9 5l7 7-7 7',
  chevronDown: 'M5 9l7 7 7-7',
  chevronUp: 'M19 15l-7-7-7 7',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  clock: 'M12 7.5V12l2.8 1.7M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  alert: 'M12 8.5v4.5M12 16.5h.01M10.3 3.9L2.6 17.2A2 2 0 004.3 20h15.4a2 2 0 001.7-2.8L13.7 3.9a2 2 0 00-3.4 0z',
  bell: 'M18 9.5a6 6 0 10-12 0c0 4.2-2 5.5-2 5.5h16s-2-1.3-2-5.5zM13.8 18.5a2 2 0 01-3.6 0',
  link: 'M10 13.5a4 4 0 005.7.3l3-3a4 4 0 10-5.7-5.7l-1.6 1.6M14 10.5a4 4 0 00-5.7-.3l-3 3a4 4 0 105.7 5.7l1.6-1.6',
  note: 'M8 4h8a2 2 0 012 2v14l-6-3-6 3V6a2 2 0 012-2zM9.5 9h5M9.5 12.5h3',
  decision: 'M12 4v16M4.5 8h15M7 8l-3 6a3 3 0 006 0L7 8zM17 8l-3 6a3 3 0 006 0l-3-6z',
  journal: 'M5 5.5A2.5 2.5 0 017.5 3H19v18H7.5A2.5 2.5 0 015 18.5v-13zM5 17.5h14M9 7.5h6',
  hourglass: 'M7 3h10M7 21h10M17 3v3.5c0 2-3 3.6-3 5.5s3 3.5 3 5.5V21M7 3v3.5c0 2 3 3.6 3 5.5s-3 3.5-3 5.5V21',
  flag: 'M5 21V4M5 4h11l-1.6 3.5L16 11H5',
  pin: 'M12 21v-7.5M8.6 3.5h6.8l-.7 5.3 2.6 3.2H6.7l2.6-3.2-.7-5.3z',
  trash: 'M4 6.5h16M9.5 6.5V4.8A1.3 1.3 0 0110.8 3.5h2.4a1.3 1.3 0 011.3 1.3v1.7M6.5 6.5l.9 12.2A1.8 1.8 0 009.2 20.5h5.6a1.8 1.8 0 001.8-1.8l.9-12.2',
  edit: 'M4 20h4l10.5-10.5a2.1 2.1 0 00-3-3L5 17v3z',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V8a2 2 0 012-2h4',
  folder: 'M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z',
  board: 'M4 6h16M4 12h10M4 18h13',
  arrowRight: 'M5 12h13M13 6l6 6-6 6',
  arrowLeft: 'M19 12H6M11 18l-6-6 6-6',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z',
  dot: 'M12 12h.01',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  archive: 'M4 8h16M5 8V6a1 1 0 011-1h12a1 1 0 011 1v2M6 8v11a1 1 0 001 1h10a1 1 0 001-1V8M10 12h4',
  command: 'M9 6a3 3 0 10-3 3h12a3 3 0 10-3-3v12a3 3 0 103-3H6a3 3 0 10 3 3V6z',
  moon: 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z',
  sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.6-5.6l1.4-1.4M5 19l1.4-1.4m0-11.2L5 5m14 14l-1.4-1.4M16 12a4 4 0 11-8 0 4 4 0 018 0z',
  filter: 'M4 6h16M7 12h10M10 18h4',
  inbox: 'M4 13h4l1.5 3h5L16 13h4M4 13l2.2-7.3A2 2 0 018.1 4.3h7.8a2 2 0 011.9 1.4L20 13v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5z',
  refresh: 'M20 11.5A8 8 0 006 6.2M4 12.5A8 8 0 0018 17.8M18 3.5v3h-3M6 20.5v-3h3',
  monitor: 'M4 5.5h16a1 1 0 011 1v9a1 1 0 01-1 1H4a1 1 0 01-1-1v-9a1 1 0 011-1zM9 20.5h6M12 16.5v4',
  droplet: 'M12 3.2c3.4 3.9 5.6 6.6 5.6 9.3a5.6 5.6 0 11-11.2 0c0-2.7 2.2-5.4 5.6-9.3zM9.3 13.7a2.8 2.8 0 002.2 2.7',
  checkbox: 'M5.5 7A1.5 1.5 0 017 5.5h10A1.5 1.5 0 0118.5 7v10a1.5 1.5 0 01-1.5 1.5H7A1.5 1.5 0 015.5 17V7z',
  chat: 'M8 18.5l-4 2.5v-4.2A2.3 2.3 0 013 14.5v-7A2.5 2.5 0 015.5 5h13A2.5 2.5 0 0121 7.5v7a2.5 2.5 0 01-2.5 2.5H8z',
  paperclip: 'M19 11.5l-7.4 7.4a4.5 4.5 0 01-6.4-6.4l8-8a3 3 0 014.2 4.2l-8 8a1.5 1.5 0 01-2.1-2.1L15 7',
  arrowUp: 'M12 19V5M6 11l6-6 6 6',
  stop: 'M8 8h8v8H8z',
  mic: 'M12 3.5a2.5 2.5 0 012.5 2.5v6a2.5 2.5 0 01-5 0V6A2.5 2.5 0 0112 3.5zM5.5 11a6.5 6.5 0 0013 0M12 17.5V21M9 21h6',
  play: 'M7.5 5.2l11 6.8-11 6.8V5.2z',
  pause: 'M9 5v14M15 5v14',
  waveform: 'M3 12h2M7 8v8M11 4.5v15M15 8v8M19 10.5v3M21.5 12h.01',
  // Two stars rather than one: the single sparkle already means the assistant, and
  // this is the smaller thing — a field filling itself in, not a conversation.
  sparkles: 'M9.5 3l1.5 4.1L15 8.5l-4 1.4L9.5 14 8 9.9 4 8.5l4-1.4L9.5 3zM17.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z',

  /*
   * The weather, on the same grid and the same single stroke as everything else, so
   * the corner of Today that reads the sky belongs to the same drawing as the rest of
   * the app. The names match the table in `shared/weather.ts`, which is the one place
   * a WMO code turns into words and a picture.
   */
  weatherSun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.6-5.6l1.4-1.4M5 19l1.4-1.4m0-11.2L5 5m14 14l-1.4-1.4M16 12a4 4 0 11-8 0 4 4 0 018 0z',
  weatherMoon: 'M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z',
  weatherCloud: 'M7 18h10a3.5 3.5 0 000-7 5 5 0 00-9.6-1.4A3.7 3.7 0 007 18z',
  weatherPartly: 'M9 19h8a3.2 3.2 0 000-6.4 4.6 4.6 0 00-8.7-1.2A3.3 3.3 0 009 19zM7.8 8.4a3.2 3.2 0 015-1.8M10.5 2.8v1.5M5.6 4.6l1.1 1.1M3.4 9.3H5',
  weatherPartlyNight: 'M9 19h8a3.2 3.2 0 000-6.4 4.6 4.6 0 00-8.7-1.2A3.3 3.3 0 009 19zM15 3a3.5 3.5 0 004.4 4.6A3.7 3.7 0 0115 3z',
  weatherFog: 'M7 15h10a3.5 3.5 0 000-7 5 5 0 00-9.6-1.4A3.7 3.7 0 007 15zM5 18.5h14M7.5 21.5h9',
  weatherDrizzle: 'M7 16.5h10a3.5 3.5 0 000-7 5 5 0 00-9.6-1.4A3.7 3.7 0 007 16.5zM9.5 19v1.2M13 19v1.8M16.5 19v1.2',
  weatherRain: 'M7 16.5h10a3.5 3.5 0 000-7 5 5 0 00-9.6-1.4A3.7 3.7 0 007 16.5zM9 19v2.2M12.5 19v2.8M16 19v2.2',
  weatherSnow: 'M7 16.5h10a3.5 3.5 0 000-7 5 5 0 00-9.6-1.4A3.7 3.7 0 007 16.5zM9.5 19.5h.01M12.5 19.5h.01M15.5 19.5h.01M11 22h.01M14 22h.01',
  weatherStorm: 'M7 16.5h10a3.5 3.5 0 000-7 5 5 0 00-9.6-1.4A3.7 3.7 0 007 16.5zM13 18.2l-2.6 3.3h2.9l-1.7 2.3',
  /** A picture, for the banner across the top of Today. */
  image: 'M4 6a2 2 0 012-2h12a2 2 0 012 2v12a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM4 16l4.5-4.5 4 4 3-3L20 16M9.3 9.3h.01',
  /** Somewhere to take hold of a row you are about to drag. */
  grip: 'M9.5 6h.01M14.5 6h.01M9.5 12h.01M14.5 12h.01M9.5 18h.01M14.5 18h.01'
} as const

interface IconProps {
  name: IconName
  className?: string
  size?: number
  strokeWidth?: number
}

export function Icon({ name, className = '', size = 16, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
