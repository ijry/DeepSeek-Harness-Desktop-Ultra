import { useI18n } from "../i18n";
import { Reveal } from "./Reveal";
import { SectionHead } from "./SectionHead";

export function Limits() {
  const { t } = useI18n();
  return (
    <section className="section section--alt" id="limits">
      <div className="container">
        <SectionHead label={t.limits.label} title={t.limits.title} lead={t.limits.lead} />
        <div className="limit-grid">
          {t.limits.items.map((item, i) => (
            <Reveal key={item.t} delay={(i % 3) * 80}>
              <article className="limit-card">
                <span className="limit-card__mark" aria-hidden="true">
                  !
                </span>
                <h3 className="limit-card__title">{item.t}</h3>
                <p className="limit-card__desc">{item.d}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}