import type { CSSProperties } from "react";
import { GITHUB_LATEST, GITHUB_REPO, HERO_CHIPS, HERO_CONSOLE, useI18n } from "../i18n";
import { Reveal } from "./Reveal";

export function Hero() {
  const { t } = useI18n();

  return (
    <section className="hero" id="top">
      <div className="container hero__inner">
        <div className="hero__copy">
          <Reveal>
            <p className="hero__badge">{t.hero.badge}</p>
          </Reveal>
          <Reveal delay={90}>
            <h1 className="hero__title">
              {t.hero.pre}
              <br />
              <span className="grad">{t.hero.hot}</span>
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="hero__sub">{t.hero.sub}</p>
          </Reveal>
          <Reveal delay={260}>
            <div className="hero__cta">
              <a className="btn btn--primary" href={GITHUB_LATEST} target="_blank" rel="noreferrer">
                {t.hero.cta}
                <span aria-hidden="true">↓</span>
              </a>
              <a className="btn btn--ghost" href={GITHUB_REPO} target="_blank" rel="noreferrer">
                {t.hero.repo}
              </a>
            </div>
          </Reveal>
          <Reveal delay={340}>
            <p className="hero__note">
              <span aria-hidden="true" className="hero__note-dot" />
              {t.hero.note}
            </p>
          </Reveal>
        </div>

        <Reveal className="hero__visual" delay={200}>
          <div className="window" role="img" aria-label="DSH Desktop Ultra startup console">
            <div className="window__bar">
              <span className="window__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span className="window__title">DSH Desktop Ultra — dsh</span>
            </div>
            <div className="window__body">
              {HERO_CONSOLE.map((line, i) => (
                <p
                  className="window__line"
                  key={line}
                  style={{ animationDelay: `${0.35 + i * 0.5}s` } as CSSProperties}
                >
                  <span className="window__prompt" aria-hidden="true">
                    $
                  </span>
                  {line}
                </p>
              ))}
              <p
                className="window__line window__line--ok"
                style={{ animationDelay: `${0.35 + HERO_CONSOLE.length * 0.5}s` } as CSSProperties}
              >
                <span className="window__caret" aria-hidden="true" />
              </p>
            </div>
            <div className="window__sheen" aria-hidden="true" />
          </div>

          <div className="hero__chips" aria-hidden="true">
            {HERO_CHIPS.map((chip, i) => (
              <span className={`chip chip--${i + 1}`} key={chip}>
                {chip}
              </span>
            ))}
          </div>
        </Reveal>
      </div>

      <a className="hero__scroll" href="#download">
        <span className="hero__scroll-text">{t.hero.scroll}</span>
        <span className="hero__scroll-line" aria-hidden="true" />
      </a>
    </section>
  );
}