import {
  GITHUB_LATEST,
  GITHUB_RELEASES,
  GITHUB_REPO,
  PLUGINS_URL,
  TAURI_URL,
  UPSTREAM_REPO,
  useI18n,
} from "../i18n";

const LOGO = `${import.meta.env.BASE_URL}logo.svg`;

export function Footer() {
  const { t } = useI18n();
  const links = [
    { id: "top", label: t.nav.brand },
    { id: "download", label: t.nav.download },
    { id: "features", label: t.nav.features },
    { id: "flow", label: t.nav.flow },
    { id: "boundaries", label: t.nav.boundaries },
    { id: "faq", label: t.nav.faq },
  ];
  return (
    <footer className="footer">
      <div className="container footer__grid">
        <div className="footer__brand">
          <img src={LOGO} alt="" width="40" height="40" />
          <h2 className="footer__tagline">{t.footer.tagline}</h2>
          <p className="footer__rights">{t.footer.rights}</p>
        </div>

        <nav className="footer__col" aria-label={t.footer.siteNav}>
          <h3>{t.footer.siteNav}</h3>
          <ul>
            {links.map((link) => (
              <li key={link.id}>
                <a href={link.id === "top" ? "#top" : `#${link.id}`}>{link.label}</a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="footer__col">
          <h3>{t.footer.project}</h3>
          <ul>
            <li><a href={GITHUB_REPO} target="_blank" rel="noreferrer">{t.nav.github}</a></li>
            <li><a href={GITHUB_LATEST} target="_blank" rel="noreferrer">Releases · latest</a></li>
            <li><a href={GITHUB_RELEASES} target="_blank" rel="noreferrer">All releases</a></li>
            <li><a href={UPSTREAM_REPO} target="_blank" rel="noreferrer">{t.footer.upstream}</a></li>
            <li><a href={PLUGINS_URL} target="_blank" rel="noreferrer">{t.footer.plugins}</a></li>
            <li><a href={TAURI_URL} target="_blank" rel="noreferrer">{t.footer.tauri}</a></li>
          </ul>
        </div>
      </div>
      <div className="container footer__bottom">
        <p>{t.footer.ossNote}</p>
        <p className="footer__license">MIT · {t.footer.oss}</p>
      </div>
    </footer>
  );
}