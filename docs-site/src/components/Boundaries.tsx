import { GITHUB_REPO, UPSTREAM_ISSUES, UPSTREAM_REPO, useI18n } from "../i18n";
import { Reveal } from "./Reveal";
import { SectionHead } from "./SectionHead";

export function Boundaries() {
  const { t } = useI18n();
  return (
    <section className="section" id="boundaries">
      <div className="container">
        <SectionHead label={t.boundaries.label} title={t.boundaries.title} lead={t.boundaries.lead} />

        <div className="rule-grid">
          {t.boundaries.rules.map((rule, i) => (
            <Reveal key={rule.t} delay={(i % 3) * 80}>
              <article className="rule-card">
                <span className="rule-card__idx" aria-hidden="true">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <h3 className="rule-card__title">{rule.t}</h3>
                <p className="rule-card__desc">{rule.d}</p>
              </article>
            </Reveal>
          ))}
        </div>

        <Reveal className="split" delay={80}>
          <div className="split__head">
            <h3>{t.boundaries.splitTitle}</h3>
            <p>{t.boundaries.note}</p>
          </div>
          <div className="split__cols">
            <div className="split__col split__col--shell">
              <h4>{t.boundaries.shellTitle}</h4>
              <ul>
                {t.boundaries.shellItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="split__col split__col--dsh">
              <h4>{t.boundaries.dshTitle}</h4>
              <ul>
                {t.boundaries.dshItems.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>

        <Reveal className="disclaimer" delay={120}>
          <p className="disclaimer__text">{t.boundaries.disclaimer}</p>
          <div className="disclaimer__links">
            <a href={UPSTREAM_REPO} target="_blank" rel="noreferrer">
              {t.boundaries.upstream} ↗
            </a>
            <a href={GITHUB_REPO} target="_blank" rel="noreferrer">
              {t.nav.github} ↗
            </a>
            <a href={UPSTREAM_ISSUES} target="_blank" rel="noreferrer">
              Issues ↗
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}