import { useState } from "react";
import { GITHUB_LATEST, GITHUB_RELEASES, useI18n, type OsId } from "../i18n";
import { detectOs } from "../platform";
import { Reveal } from "./Reveal";
import { SectionHead } from "./SectionHead";

const ORDER: OsId[] = ["windows", "macos", "linux"];

const OS_LABEL: Record<OsId, string> = {
  windows: "Windows",
  macos: "macOS",
  linux: "Linux",
};

export function Download() {
  const { t } = useI18n();
  const [detected] = useState<OsId | null>(() => detectOs());

  return (
    <section className="section" id="download">
      <div className="container">
        <SectionHead label={t.download.label} title={t.download.title} lead={t.download.lead} />

        {detected ? (
          <Reveal className="download__auto">
            <span className="download__auto-dot" aria-hidden="true" />
            {t.download.autoNote} <strong>{OS_LABEL[detected]}</strong>
          </Reveal>
        ) : null}

        <div className="download__grid">
          {ORDER.map((os, i) => {
            const item = t.download.items[os];
            const isRec = detected === os;
            return (
              <Reveal key={os} delay={i * 90}>
                <a
                  className={`os-card${isRec ? " os-card--rec" : ""}`}
                  href={GITHUB_LATEST}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div className="os-card__head">
                    <span className={`os-dot os-dot--${os}`} aria-hidden="true" />
                    <span className="os-card__name">{OS_LABEL[os]}</span>
                    {isRec ? <span className="os-card__rec">{t.download.recommended}</span> : null}
                  </div>
                  <p className="os-card__file">{item.file}</p>
                  <p className="os-card__desc">{item.desc}</p>
                  <span className="os-card__cta">
                    {t.download.open}
                    <span aria-hidden="true">↗</span>
                  </span>
                </a>
              </Reveal>
            );
          })}
        </div>

        <Reveal className="download__meta">
          <p>{t.download.updaterHint}</p>
          <a className="download__all" href={GITHUB_RELEASES} target="_blank" rel="noreferrer">
            {t.nav.github} Releases ↗
          </a>
        </Reveal>
      </div>
    </section>
  );
}