/**
 * Icons: inline SVG built with createElementNS, so no `innerHTML` is needed and
 * no icon asset has to be served.
 *
 * The reference resolves per-extension file icons from the 910-file
 * vscode-material-icons package. Shipping that here would mean serving a second
 * asset directory for a Git panel, so instead one glyph is drawn per FAMILY of
 * file type and coloured by extension — the same information (what kind of file
 * this is) at a fraction of the weight.
 */

/** 16x16 path data, keyed by name. Multiple paths are separated by `|`. */
const ICON_PATHS = {
  git: 'M15.7 7.3 8.7.3a1 1 0 0 0-1.4 0L5.5 2.1l2.2 2.2a1.2 1.2 0 0 1 1.6 1.6l2.1 2.1a1.2 1.2 0 1 1-.7.7L8.7 6.7v5a1.2 1.2 0 1 1-1-.1V6.4a1.2 1.2 0 0 1-.6-1.6L4.8 2.6.3 7.3a1 1 0 0 0 0 1.4l7 7a1 1 0 0 0 1.4 0l7-7a1 1 0 0 0 0-1.4z',
  files: 'M9.5 1H4a1.5 1.5 0 0 0-1.5 1.5v11A1.5 1.5 0 0 0 4 15h8a1.5 1.5 0 0 0 1.5-1.5V5L9.5 1zm0 1.6L11.9 5H9.5V2.6zM4 2h4.5v3.5H12v8H4V2z|M5.5 7.5h5v1h-5zM5.5 10h5v1h-5z',
  clock: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 1.2A5.8 5.8 0 1 1 8 13.8 5.8 5.8 0 0 1 8 2.2zm-.6 2v4.1l3.2 1.9.6-1-2.6-1.5V4.2z',
  branch: 'M11.5 2a2.5 2.5 0 0 0-1 4.8v.4a2 2 0 0 1-2 2H6.4a2.5 2.5 0 0 0-1.9-1.1V6.8a2.5 2.5 0 1 0-1 0v4.4a2.5 2.5 0 1 0 1 0v-1.9a2 2 0 0 0 1.9 1.2h2.1a3 3 0 0 0 3-3v-.7A2.5 2.5 0 0 0 11.5 2zm0 1a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM4 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm0 9.2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  tag: 'M7.6 1.4a1 1 0 0 0-.7.3L1.7 7a1 1 0 0 0 0 1.4l5.9 5.9a1 1 0 0 0 1.4 0l5.3-5.3a1 1 0 0 0 .3-.7V2.4a1 1 0 0 0-1-1H7.6zm.4 1h5.6v5.6L8.3 13.2 2.8 7.7 8 2.4zM11 3.6a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
  stash: 'M2 3.5h12v1.2H2zM2 6.4h12v1.2H2zM2.5 9h11l-1 4.2a1 1 0 0 1-1 .8H4.5a1 1 0 0 1-1-.8L2.5 9zm1.3 1.2.7 2.8h7l.7-2.8H3.8z',
  remote: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm4.7 4.3h-2A9 9 0 0 0 9.4 2.5a5.8 5.8 0 0 1 3.3 2.8zM8 2.2c.7.6 1.4 1.7 1.7 3.1H6.3C6.6 3.9 7.3 2.8 8 2.2zM2.4 8c0-.5.1-1 .2-1.5h2.3a12 12 0 0 0 0 3H2.6A5.8 5.8 0 0 1 2.4 8zm.9 2.7h2A9 9 0 0 0 6.6 13.5a5.8 5.8 0 0 1-3.3-2.8zm2-5.4h-2a5.8 5.8 0 0 1 3.3-2.8A9 9 0 0 0 5.3 5.3zM8 13.8c-.7-.6-1.4-1.7-1.7-3.1h3.4c-.3 1.4-1 2.5-1.7 3.1zm1.9-4.3H6.1a11 11 0 0 1 0-3h3.8a11 11 0 0 1 0 3zm-.5 4a9 9 0 0 0 1.3-2.8h2a5.8 5.8 0 0 1-3.3 2.8zm1.7-4a12 12 0 0 0 0-3h2.3a5.8 5.8 0 0 1 0 3z',
  submodule: 'M2 2h5v5H2V2zm1.2 1.2v2.6h2.6V3.2H3.2zM9 2h5v5H9V2zm1.2 1.2v2.6h2.6V3.2h-2.6zM2 9h5v5H2V9zm1.2 1.2v2.6h2.6v-2.6H3.2zM9 9h5v5H9V9zm1.2 1.2v2.6h2.6v-2.6h-2.6z',
  worktree: 'M3 1.5h4.2a1 1 0 0 1 1 1v2h4.3a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1zm.2 1.2v10.6H12.3V5.7H7v-3H3.2z',
  refresh: 'M8 2.4a5.6 5.6 0 0 1 5 3.1l1.1-.5A6.8 6.8 0 0 0 8 1.2V0L5 2.4 8 4.8V2.4zM8 13.6a5.6 5.6 0 0 1-5-3.1l-1.1.5A6.8 6.8 0 0 0 8 14.8V16l3-2.4L8 11.2v2.4z',
  download: 'M7.4 1.5h1.2v7.1l2.3-2.3.9.9L8 11 4.2 7.2l.9-.9 2.3 2.3V1.5zM2.5 12.2h11v1.2h-11z',
  upload: 'M8 1.4 11.8 5.2l-.9.9-2.3-2.3v7.1H7.4V3.8L5.1 6.1l-.9-.9L8 1.4zM2.5 12.2h11v1.2h-11z',
  merge: 'M4 2a2.5 2.5 0 0 1 .5 4.9v.2a3 3 0 0 0 3 3h1.1a2.5 2.5 0 1 1 0 1H7.5a4 4 0 0 1-3-1.4v1.4a2.5 2.5 0 1 1-1 0V6.9A2.5 2.5 0 0 1 4 2zm0 1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm7.5 6.1a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zM4 12.2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  settings: 'M8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8zm0 1.2a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4zM6.9 1h2.2l.3 1.7 1 .4 1.4-1 1.6 1.6-1 1.4.4 1 1.7.3v2.2l-1.7.3-.4 1 1 1.4-1.6 1.6-1.4-1-1 .4-.3 1.7H6.9l-.3-1.7-1-.4-1.4 1-1.6-1.6 1-1.4-.4-1L1.5 9.1V6.9l1.7-.3.4-1-1-1.4 1.6-1.6 1.4 1 1-.4L6.9 1z',
  plus: 'M7.4 2.5h1.2v4.9h4.9v1.2H8.6v4.9H7.4V8.6H2.5V7.4h4.9V2.5z',
  minus: 'M2.5 7.4h11v1.2h-11z',
  undo: 'M7.5 3.2V1L3.7 4.1l3.8 3.1V5.4a4 4 0 1 1-4 4H2.3a5.2 5.2 0 1 0 5.2-6.2z',
  trash: 'M6.2 1.5h3.6l.5 1h3.2v1.2H2.5V2.5h3.2l.5-1zM3.5 4.9h9l-.7 8.5a1.2 1.2 0 0 1-1.2 1.1H5.4a1.2 1.2 0 0 1-1.2-1.1L3.5 4.9zm1.3 1.2.6 7.2h5.2l.6-7.2H4.8z',
  close: 'M4 3.2 8 7.1l4-3.9.9.8L9 8l3.9 4-.9.8L8 8.9l-4 3.9-.8-.8L7.1 8 3.2 4z',
  check: 'M13.2 4.2 6.4 11 2.8 7.4l.9-.8 2.7 2.7 6-6z',
  caret: 'M4.4 6.2h7.2L8 10.4z',
  folder: 'M1.8 3a1 1 0 0 1 1-1h3.1l1.4 1.6h6a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1V3zm1.2.2v9.6h9.9V4.8H6.8L5.4 3.2H3z',
  file: 'M4 1h5.2L13 4.8V15H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm5 1.6V5h2.4L9 2.6zM4.2 2.2v11.6h7.6V6.2H7.8V2.2H4.2z',
  image: 'M2 3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3zm1.2.2v7.3l2.6-2.6 2.4 2.4 2-2 2.6 2.6V3.2H3.2zm0 9v.6h9.6v-.9L10.2 9.4l-2 2-2.4-2.4-2.6 2.6z|M5.6 4.6a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2z',
  wand: 'M11.2 1.4l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7.7-1.9zM3.4 6.2l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3zM8.5 6.9 9.9 8.3 4.2 14 2.8 12.6 8.5 6.9zM9.6 8.6 8.2 7.2l.7-.7 1.4 1.4-.7.7z',
  search: 'M6.8 1.6a5.2 5.2 0 1 0 3.2 9.3l3.2 3.2.9-.9-3.2-3.2A5.2 5.2 0 0 0 6.8 1.6zm0 1.2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  more: 'M3.2 6.8a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm4.8 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm4.8 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z',
  inbox: 'M2 2.5h12a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zm.2 1.2v4.6h3.1l.7 1.5h4l.7-1.5h3.1V3.7H2.2zm0 5.8v3.1h11.6V9.5h-2.3l-.7 1.5H5.2l-.7-1.5H2.2z',
  lock: 'M8 1.4a3 3 0 0 1 3 3v1.4h.8a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1H5V4.4a3 3 0 0 1 3-3zm0 1.2a1.8 1.8 0 0 0-1.8 1.8v1.4h3.6V4.4A1.8 1.8 0 0 0 8 2.6zM4.4 7v5.6h7.2V7H4.4z',
  external: 'M9 1.5h5.5V7h-1.2V3.6l-6 6-.9-.9 6-6H9V1.5zM2 4h4.5v1.2H3.2v7.6h7.6V9.5H12V14a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  copy: 'M5.5 1.5h7a1 1 0 0 1 1 1v7h-1.2V2.7H5.5V1.5zM3 4h6.5a1 1 0 0 1 1 1v8.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm.2 1.2v8.1h6.1V5.2H3.2z',
  play: 'M4.5 2.2 12.5 8l-8 5.8V2.2z',
  cancel: 'M8 1.4a6.6 6.6 0 1 0 0 13.2A6.6 6.6 0 0 0 8 1.4zm0 1.2a5.4 5.4 0 0 1 3.4 1.2L3.8 11.4A5.4 5.4 0 0 1 8 2.6zm0 10.8a5.4 5.4 0 0 1-3.4-1.2l7.6-7.6A5.4 5.4 0 0 1 8 13.4z',
}

/** One icon element. `size` defaults to 100% of its box. */
function icon(name, size) {
  const paths = ICON_PATHS[name] ?? ICON_PATHS.file
  const node = svg('svg', {
    viewBox: '0 0 16 16',
    fill: 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false',
    width: size,
    height: size,
  })
  for (const d of paths.split('|')) node.append(svg('path', { d }))
  return node
}

/**
 * Extension families and their accent colour. Ordered: the first family whose
 * extension list contains the suffix wins, so `.d.ts` lands on TypeScript before
 * the generic-source fallback.
 */
const FILE_FAMILIES = [
  { color: '#3178c6', glyph: 'file', ext: ['ts', 'tsx', 'mts', 'cts'] },
  { color: '#f1dd35', glyph: 'file', ext: ['js', 'jsx', 'mjs', 'cjs'] },
  { color: '#41b883', glyph: 'file', ext: ['vue'] },
  { color: '#dea584', glyph: 'file', ext: ['rs'] },
  { color: '#00add8', glyph: 'file', ext: ['go'] },
  { color: '#3572a5', glyph: 'file', ext: ['py', 'pyi'] },
  { color: '#b07219', glyph: 'file', ext: ['java', 'kt', 'kts', 'scala', 'groovy'] },
  { color: '#f34b7d', glyph: 'file', ext: ['c', 'h', 'cc', 'cpp', 'hpp', 'cxx', 'm', 'mm'] },
  { color: '#701516', glyph: 'file', ext: ['rb', 'erb', 'gemspec'] },
  { color: '#4f5d95', glyph: 'file', ext: ['php'] },
  { color: '#178600', glyph: 'file', ext: ['cs', 'fs', 'vb'] },
  { color: '#e34c26', glyph: 'file', ext: ['html', 'htm', 'xhtml', 'svelte', 'astro'] },
  { color: '#563d7c', glyph: 'file', ext: ['css', 'scss', 'sass', 'less', 'styl'] },
  { color: '#8a9bb0', glyph: 'file', ext: ['json', 'json5', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties'] },
  { color: '#5c9ded', glyph: 'file', ext: ['md', 'markdown', 'mdx', 'rst', 'txt', 'adoc'] },
  { color: '#89e051', glyph: 'file', ext: ['sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd'] },
  { color: '#e0a13c', glyph: 'file', ext: ['sql', 'db', 'sqlite'] },
  { color: '#7e57c2', glyph: 'image', ext: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'tif', 'tiff'] },
  { color: '#a1887f', glyph: 'file', ext: ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'whl'] },
  { color: '#f05033', glyph: 'git', ext: ['gitignore', 'gitattributes', 'gitmodules', 'gitkeep'] },
  { color: '#2496ed', glyph: 'file', ext: ['dockerfile', 'dockerignore'] },
  { color: '#e0a13c', glyph: 'file', ext: ['lock'] },
]

/** Exact file names that get their own colour regardless of suffix. */
const FILE_NAMES = {
  'package.json': '#8bc34a',
  'package-lock.json': '#8bc34a',
  'pnpm-lock.yaml': '#f9ad00',
  'cargo.toml': '#dea584',
  'cargo.lock': '#dea584',
  'dockerfile': '#2496ed',
  'makefile': '#6d8086',
  'license': '#d0b000',
  'readme.md': '#5c9ded',
  '.gitignore': '#f05033',
  '.gitattributes': '#f05033',
  '.gitmodules': '#f05033',
}

/** An icon for one path, coloured by what kind of file it is. */
function fileIcon(path, options) {
  const opts = options ?? {}
  if (opts.directory === true) {
    const node = icon('folder')
    node.style.color = '#8ab4f8'
    return node
  }
  const name = baseName(path).toLowerCase()
  const exact = FILE_NAMES[name]
  const suffix = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  const family = FILE_FAMILIES.find((row) => row.ext.includes(suffix) || row.ext.includes(name.replace(/^\./, '')))
  const node = icon(family === undefined ? 'file' : family.glyph)
  node.style.color = exact ?? (family === undefined ? 'var(--og-text-3)' : family.color)
  return node
}
