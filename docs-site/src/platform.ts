export type OsId = "windows" | "macos" | "linux";

function hint(value: string | undefined, ua: string): OsId | null {
  if (!value) return null;
  if (/mac|iphone|ipad|ipod/i.test(value) || /Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/win/i.test(value) || /Windows/i.test(ua)) return "windows";
  if (/linux/i.test(value) || /linux|X11|CrOS/i.test(ua)) return "linux";
  return null;
}

export function detectOs(): OsId | null {
  try {
    const ua = navigator.userAgent;
    const uad = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
    const platform = uad?.platform ?? (navigator as { platform?: string }).platform;
    return hint(platform, ua);
  } catch {
    return null;
  }
}