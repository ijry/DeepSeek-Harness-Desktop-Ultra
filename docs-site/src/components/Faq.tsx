import { useI18n } from "../i18n";
import { Reveal } from "./Reveal";
import { SectionHead } from "./SectionHead";

export function Faq() {
  const { t } = useI18n();
  return (
    <section className="section" id="faq">
      <div className="container container--narrow">
        <SectionHead label={t.faq.label} title={t.faq.title} />
        <div className="faq-list">
          {t.faq.items.map((item, i) => (
            <Reveal key={item.q} delay={i * 50}>
              <details className="faq-item">
                <summary>
                  <span className="faq-item__q">{item.q}</span>
                  <span className="faq-item__icon" aria-hidden="true" />
                </summary>
                <p className="faq-item__a">{item.a}</p>
              </details>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}