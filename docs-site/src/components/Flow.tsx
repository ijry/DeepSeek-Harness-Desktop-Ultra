import { useI18n } from "../i18n";
import { Reveal } from "./Reveal";
import { SectionHead } from "./SectionHead";

export function Flow() {
  const { t } = useI18n();
  return (
    <section className="section section--alt" id="flow">
      <div className="container">
        <SectionHead label={t.flow.label} title={t.flow.title} lead={t.flow.lead} />
        <ol className="flow-steps">
          {t.flow.steps.map((step, i) => (
            <li key={step.t}>
              <Reveal delay={(i % 2) * 90}>
                <article className="flow-card">
                  <span className="flow-card__num" aria-hidden="true">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="flow-card__body">
                    <h3 className="flow-card__title">{step.t}</h3>
                    <p className="flow-card__desc">{step.d}</p>
                  </div>
                </article>
              </Reveal>
            </li>
          ))}
        </ol>
        <Reveal className="flow-note">
          <span aria-hidden="true" className="flow-note__mark">
            !
          </span>
          <p>{t.flow.note}</p>
        </Reveal>
      </div>
    </section>
  );
}