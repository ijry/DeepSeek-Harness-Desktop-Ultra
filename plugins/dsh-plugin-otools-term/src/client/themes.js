/**
 * The terminal colour schemes, ported verbatim from the reference plugin's
 * `src/themes.js` — same twelve names in the same order, same hex values, so a user
 * who picked "gruvbox" over there gets the same terminal here.
 *
 * Two changes were unavoidable:
 *
 *  - xterm 4 called the selection colour `selection`; xterm 5 calls it
 *    `selectionBackground`. The reference kept the old key, which means its
 *    selection colour silently stopped working when it moved to xterm 5. Both keys
 *    are set here.
 *  - `accent-light` followed the host shell's Element Plus custom properties
 *    (`--el-color-primary` and friends). DSH's shell exposes `--dsw-alias-*`
 *    instead, so those are read; the fallbacks are the reference's one-light values,
 *    which is what it looked like before any accent was applied.
 */

const ACCENT_LIGHT_THEME = 'accent-light'

/** Build one xterm theme from the reference's field order. */
function makeTheme(background, foreground, cursor, selection, normal, bright) {
  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selection,
    selectionBackground: selection,
    black: normal[0],
    red: normal[1],
    green: normal[2],
    yellow: normal[3],
    blue: normal[4],
    magenta: normal[5],
    cyan: normal[6],
    white: normal[7],
    brightBlack: bright[0],
    brightRed: bright[1],
    brightGreen: bright[2],
    brightYellow: bright[3],
    brightBlue: bright[4],
    brightMagenta: bright[5],
    brightCyan: bright[6],
    brightWhite: bright[7],
  }
}

/** The one-light palette `accent-light` is built on. */
const ACCENT_LIGHT_BASE = makeTheme('#ffffff', '#383a42', '#526fff', 'rgba(82, 111, 255, 0.2)',
  ['#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7'],
  ['#696c77', '#d33f32', '#22863a', '#b07000', '#315fdb', '#8e1f8c', '#006f9a', '#ffffff'])

/** Every theme, in the reference's declaration order. */
const THEMES = {
  midnight: makeTheme('#0b0f14', '#d6dde6', '#8fb3ff', 'rgba(143, 179, 255, 0.35)',
    ['#0b0f14', '#ff6b6b', '#46d39a', '#f8d26a', '#5aa9ff', '#c58bff', '#4fd1c5', '#d6dde6'],
    ['#556070', '#ff8787', '#6ee7b7', '#fde68a', '#7ab8ff', '#d7a7ff', '#7ee6e0', '#f2f5f9']),
  nord: makeTheme('#2e3440', '#d8dee9', '#88c0d0', 'rgba(136, 192, 208, 0.35)',
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
    ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  gruvbox: makeTheme('#282828', '#ebdbb2', '#fabd2f', 'rgba(250, 189, 47, 0.3)',
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
    ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  oneDark: makeTheme('#282c34', '#abb2bf', '#528bff', 'rgba(82, 139, 255, 0.3)',
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
    ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  catppuccin: makeTheme('#1e1e2e', '#cdd6f4', '#f5e0dc', 'rgba(245, 224, 220, 0.28)',
    ['#1e1e2e', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#cba6f7', '#94e2d5', '#bac2de'],
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#cba6f7', '#94e2d5', '#f5e0dc']),
  solarized: makeTheme('#002b36', '#839496', '#93a1a1', 'rgba(147, 161, 161, 0.3)',
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  'solarized-light': makeTheme('#fdf6e3', '#657b83', '#586e75', 'rgba(101, 123, 131, 0.25)',
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
    ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  'one-light': makeTheme('#fafafa', '#383a42', '#526fff', 'rgba(82, 111, 255, 0.2)',
    ['#383a42', '#e45649', '#50a14f', '#c18401', '#4078f2', '#a626a4', '#0184bc', '#a0a1a7'],
    ['#696c77', '#d33f32', '#22863a', '#b07000', '#315fdb', '#8e1f8c', '#006f9a', '#ffffff']),
  'github-light': makeTheme('#ffffff', '#24292f', '#0969da', 'rgba(9, 105, 218, 0.2)',
    ['#24292f', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#57606a'],
    ['#6e7781', '#a40e26', '#116329', '#7d4e00', '#0550ae', '#6639ba', '#11606a', '#f6f8fa']),
  'gruvbox-light': makeTheme('#fbf1c7', '#3c3836', '#b57614', 'rgba(181, 118, 20, 0.2)',
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#7c6f64'],
    ['#928374', '#9d0006', '#79740e', '#b57614', '#076678', '#8f3f71', '#427b58', '#f9f5d7']),
  dracula: makeTheme('#282a36', '#f8f8f2', '#f8f8f2', 'rgba(189, 147, 249, 0.35)',
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
    ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  [ACCENT_LIGHT_THEME]: ACCENT_LIGHT_BASE,
}

/** The synthetic option that follows the shell's light/dark state. */
const THEME_DEFAULT_OPTION = 'default'
const DARK_MODE_DEFAULT_THEME = 'nord'
const LIGHT_MODE_DEFAULT_THEME = ACCENT_LIGHT_THEME

/** Every option the picker offers, in the reference's order. */
function themeOptions() {
  return [THEME_DEFAULT_OPTION, ...Object.keys(THEMES)]
}

/** Whether the DSH shell is in dark mode right now. */
function isDarkShell() {
  if (typeof document === 'undefined') return false
  const root = document.documentElement
  if (root.classList !== undefined && typeof root.classList.contains === 'function' && root.classList.contains('dark')) return true
  const attr = typeof root.getAttribute === 'function' ? root.getAttribute('data-theme') : null
  if (attr === 'dark') return true
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
    } catch {
      return false
    }
  }
  return false
}

/** One CSS custom property off the document root, or a fallback. */
function readThemeVar(name, fallback) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  try {
    const value = window.getComputedStyle(document.documentElement).getPropertyValue(name)
    const text = typeof value === 'string' ? value.trim() : ''
    return text.length > 0 ? text : fallback
  } catch {
    return fallback
  }
}

/** `accent-light`, resolved against the DSH shell's own design tokens. */
function resolveAccentLight() {
  return {
    ...ACCENT_LIGHT_BASE,
    background: readThemeVar('--dsw-alias-bg-base', ACCENT_LIGHT_BASE.background),
    foreground: readThemeVar('--dsw-alias-label-primary', ACCENT_LIGHT_BASE.foreground),
    cursor: readThemeVar('--dsw-alias-label-primary', ACCENT_LIGHT_BASE.cursor),
    black: readThemeVar('--dsw-alias-label-primary', ACCENT_LIGHT_BASE.black),
  }
}

/** The theme object for one name, falling back the way the reference did. */
function getTheme(name) {
  const wanted = name === THEME_DEFAULT_OPTION || name === undefined || name === null || name === ''
    ? (isDarkShell() ? DARK_MODE_DEFAULT_THEME : LIGHT_MODE_DEFAULT_THEME)
    : name
  if (wanted === ACCENT_LIGHT_THEME) return resolveAccentLight()
  return THEMES[wanted] ?? THEMES.midnight
}

/** The name a `default` choice resolves to right now. */
function effectiveThemeName(name) {
  if (name === undefined || name === null || name === '' || name === THEME_DEFAULT_OPTION) {
    return isDarkShell() ? DARK_MODE_DEFAULT_THEME : LIGHT_MODE_DEFAULT_THEME
  }
  return THEMES[name] === undefined ? 'midnight' : name
}
