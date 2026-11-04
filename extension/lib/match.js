// Blocked-site matching.
//
// Pattern forms (case-insensitive):
//   bank.com                 that host and every subdomain, any scheme
//   *.bank.com               subdomains only
//   https://bank.com         that origin (any path)
//   https://*.bank.com/app/* glob over the full URL; "*" matches anything

const esc = (s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
const glob = (s) => esc(s).replace(/\*/g, ".*");

export function patternToTest(pattern) {
  const p = pattern.trim().toLowerCase();
  if (!p) return () => false;
  if (!p.includes("://")) {
    if (p.startsWith("*.")) {
      const base = p.slice(2);
      return (url) => {
        const h = hostOf(url);
        return h !== null && h.endsWith("." + base);
      };
    }
    const re = new RegExp(`^${glob(p)}$`);
    return (url) => {
      const h = hostOf(url);
      return h !== null && (re.test(h) || h.endsWith("." + p));
    };
  }
  const [scheme, rest] = p.split("://");
  const hasPath = rest.includes("/");
  const re = new RegExp(`^${glob(scheme)}://${glob(hasPath ? rest : rest + "/*")}$`);
  return (url) => {
    try {
      const u = new URL(url);
      return re.test(`${u.protocol.slice(0, -1)}://${u.host}${u.pathname}${u.search}`.toLowerCase());
    } catch {
      return false;
    }
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The first pattern that blocks `url`, or null. */
export function blockedBy(url, patterns) {
  if (!url || !patterns?.length) return null;
  for (const p of patterns) if (patternToTest(p)(url)) return p;
  return null;
}
