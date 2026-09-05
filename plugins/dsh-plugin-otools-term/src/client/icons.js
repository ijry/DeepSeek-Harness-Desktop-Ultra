/**
 * The icon set: 20×20 stroked glyphs, built with `svg()` rather than `innerHTML`.
 *
 * The reference used Element Plus's icon components plus a few hand-drawn SVGs in
 * its toolbar; those hand-drawn ones (the sidebar toggle, the command list, the
 * starred folder) are reproduced here path for path, and the rest are drawn in the
 * same 1.8-stroke style so the set looks like one family.
 */

/** Path data per icon. A string is one path; an array is several. */
const ICON_PATHS = {
  terminal: ['M2.5 4.5h15v11h-15z', 'm6 8 2 2-2 2', 'M10.5 12.5h3.5'],
  'sidebar-collapse': ['M2.75 3.25h14.5v13.5H2.75z', 'M7.5 3.75v12.5', 'M12.75 10H17', 'm10.75 8 2 2-2 2'],
  'sidebar-expand': ['M2.75 3.25h14.5v13.5H2.75z', 'M7.5 3.75v12.5', 'M10.75 10H15', 'm12.75 8-2 2 2 2'],
  commands: ['M2.5 3.5h15v13h-15z', 'M5.75 7.25h5.5', 'm5.75 10 1.8-1.8', 'm5.75 10 1.8 1.8', 'M10 12.75h4.25'],
  'folder-star': [
    'M2.75 6.25a2 2 0 0 1 2-2H8l1.45 1.6a1.4 1.4 0 0 0 1.03.45h4.77a2 2 0 0 1 2 2v5.45a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2z',
    'm13.15 9.15.48 1.02 1.12.18-.8.78.18 1.1-.98-.54-.98.54.18-1.1-.8-.78 1.12-.18z',
  ],
  folder: ['M2.75 6.25a2 2 0 0 1 2-2H8l1.45 1.6a1.4 1.4 0 0 0 1.03.45h4.77a2 2 0 0 1 2 2v5.45a2 2 0 0 1-2 2H4.75a2 2 0 0 1-2-2z'],
  file: ['M5 2.75h6l4 4v10.5H5z', 'M11 2.75V7h4'],
  upload: ['M10 14.5V5.5', 'm6.5 9 3.5-3.5L13.5 9', 'M3.5 16.5h13'],
  download: ['M10 5.5v9', 'm6.5 11 3.5 3.5L13.5 11', 'M3.5 16.5h13'],
  refresh: ['M16.5 10a6.5 6.5 0 1 1-2.2-4.87', 'M16.5 3.5V7h-3.5'],
  plus: ['M10 4.5v11', 'M4.5 10h11'],
  close: ['m5 5 10 10', 'm15 5-10 10'],
  more: ['M5 10h.01', 'M10 10h.01', 'M15 10h.01'],
  settings: ['M10 12.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5z', 'M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M15.3 4.7l-1.4 1.4M6.1 13.9l-1.4 1.4'],
  search: ['M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12z', 'm13.5 13.5 3.5 3.5'],
  monitor: ['M3 4.5h14v9H3z', 'M7.5 17h5', 'M10 13.5V17'],
  server: ['M3.5 4h13v4h-13z', 'M3.5 12h13v4h-13z', 'M6 6h.01M6 14h.01'],
  key: ['M12.5 3.5a4 4 0 1 0-3.2 6.4L4 15.2V17h1.8l1-1h1.5v-1.5h1.5l1.4-1.4a4 4 0 0 0 5.3-5.3', 'M13.8 6.2h.01'],
  trash: ['M4.5 6.5h11', 'M8 6.5V4.5h4v2', 'M6 6.5 6.7 17h6.6L14 6.5', 'M8.7 9.5v5M11.3 9.5v5'],
  edit: ['m4 16 1-3.5 8-8 2.5 2.5-8 8z', 'M12 5.5 14.5 8'],
  link: ['M8.5 11.5 6 14a2.5 2.5 0 0 1-3.5-3.5l2.5-2.5', 'M11.5 8.5 14 6a2.5 2.5 0 0 1 3.5 3.5L15 12', 'm7.5 12.5 5-5'],
  tunnel: ['M3 10h5', 'M12 10h5', 'm8 6.5 4 3.5-4 3.5'],
  sparkles: ['m10 3 1.4 3.2L14.6 7.6l-3.2 1.4L10 12.2 8.6 9 5.4 7.6 8.6 6.2z', 'M15 13l.7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z'],
  play: ['m6.5 4.5 9 5.5-9 5.5z'],
  chevron: ['m8 6 4 4-4 4'],
  check: ['m4.5 10.5 3.5 3.5 7.5-8'],
  warning: ['M10 3.5 17.5 16.5H2.5z', 'M10 8v3.5M10 14h.01'],
  eye: ['M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5S2.5 10 2.5 10z', 'M10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z'],
  copy: ['M7 7h9v9H7z', 'M4.5 12.5V4h8'],
  home: ['m3.5 9.5 6.5-6 6.5 6', 'M5.5 8.5V16h9V8.5'],
  arrowUp: ['M10 15.5V5', 'm5.5 9.5 4.5-4.5 4.5 4.5'],
  lock: ['M5.5 9h9v7.5h-9z', 'M7.5 9V6.75a2.5 2.5 0 0 1 5 0V9'],
}

/**
 * One icon element. `size` is the rendered box; the artwork is a 20-unit grid.
 */
function icon(name, size) {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.file
  const list = Array.isArray(paths) ? paths : [paths]
  return svg('svg', {
    viewBox: '0 0 20 20',
    width: size ?? 16,
    height: size ?? 16,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.8,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, ...list.map((d) => svg('path', { d })))
}
