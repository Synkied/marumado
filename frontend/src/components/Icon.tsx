// One authored outline set: 24px grid, 1.6 stroke, round joins.
const PATHS: Record<string, string> = {
  folder: 'M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2.2h8.8A1.5 1.5 0 0 1 21 8.7v9.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z',
  chip: 'M7 7h10v10H7Z M10 10h4v4h-4Z M9 3v4 M12 3v4 M15 3v4 M9 17v4 M12 17v4 M15 17v4 M3 9h4 M3 12h4 M3 15h4 M17 9h4 M17 12h4 M17 15h4',
  globe: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18Z M3 12h18 M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9 M12 3c-2.6 2.6-3.8 5.6-3.8 9s1.2 6.4 3.8 9 M4.6 7.5h14.8 M4.6 16.5h14.8',
  ports: 'M9.5 3.5h5v4h-5Z M3.5 16.5h5v4h-5Z M15.5 16.5h5v4h-5Z M12 7.5v4.5 M6 16.5V12h12v4.5',
  container: 'M3 13h18c-.6 4-4 7-9.2 7C6.9 20 3.6 17.4 3 13Z M5 13V10h3v3 M8 13V10h3v3 M11 13V10h3v3 M8 10V7h3v3 M11 10V7h3v3 M14 13v-3h3v3 M19.5 13c.4-1.4 1.5-2.1 2.5-2',
  processes: 'M4 5h16 M4 10h10 M4 15h13 M4 20h7',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13Z M15.2 15.2 20 20',
  chevron: 'M6 9.5l6 6 6-6',
  arrow: 'M4 12h15 M13.5 6.5 19 12l-5.5 5.5',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10',
  back: 'M20 12H5 M10.5 6.5 5 12l5.5 5.5',
  close: 'M6 6l12 12 M18 6 6 18',
  plus: 'M12 5v14 M5 12h14',
  refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8 M4 4v4h4 M4 13a8 8 0 0 0 14.3 4.9L20 16 M20 20v-4h-4',
  pin: 'M9 3h6l-1 6 3 3H7l3-3Z M12 12v9',
  edit: 'M4 20h4L19 9l-4-4L4 16Z M13.5 6.5l4 4',
  copy: 'M9 9h10v11H9Z M5 15V4h10',
  play: 'M7 5v14l11-7Z',
  stop: 'M6.5 6.5h11v11h-11Z',
  restart: 'M4 12a8 8 0 1 0 2.4-5.7L4 8.5 M4 4v4.5h4.5',
  terminal: 'M3.5 5h17v14h-17Z M7 9.5l3 2.5-3 2.5 M12 15h5',
  sliders: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 5v4 M9 15v4',
  branch: 'M7 4v12 M7 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z M17 4a2 2 0 1 0 0 4a2 2 0 1 0 0-4Z M17 8c0 5-10 3-10 8',
  repo: 'M6 3.5h11.5v14H7.5A1.5 1.5 0 0 0 6 19v-15.5Z M6 19a1.5 1.5 0 0 0 1.5 1.5h10v-3 M9.5 7.5h5',
  dot: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8Z',
  momentum: 'M3 17.5l5.5-5.5 4 3.5L20 8 M15 8h5v5',
  skills: 'M12 3.5l7.5 4.25v8.5L12 20.5l-7.5-4.25v-8.5Z M12 12l7.5-4.25 M12 12v8.5 M12 12 4.5 7.75',
  server: 'M4 4.5h16v6H4Z M4 13.5h16v6H4Z M7.5 7.5h.01 M7.5 16.5h.01 M11 7.5h5.5 M11 16.5h5.5',
  file: 'M6.5 3.5h7l4 4v13h-11Z M13.5 3.5v4h4',
  eye: 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z',
  'eye-off': 'M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z M4 4l16 16',
  lock: 'M5.5 11h13v9.5h-13Z M8.5 11V7.5a3.5 3.5 0 0 1 7 0V11 M12 14.5v2.5',
  tasks: 'M4 6.5l1.8 1.8L9 5 M4 12.5l1.8 1.8L9 11 M4 18.5h5 M12 7h8 M12 13h8 M12 18.5h8',
  trash: 'M4.5 6.5h15 M9.5 6.5V4h5v2.5 M6.5 6.5l1 13.5h9l1-13.5 M10 10.5v6 M14 10.5v6',
  agent: 'M12 3v18 M4.2 7.5l15.6 9 M4.2 16.5l15.6-9 M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5Z',
}

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
