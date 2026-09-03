import type { ReactElement } from "react";
import { useI18n } from "../i18n";
import { Reveal } from "./Reveal";
import { SectionHead } from "./SectionHead";

function FeatureIcon({ index }: { index: number }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  const icons: ReactElement[] = [
    // 原生窗口
    <svg {...common}>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M3 8.5h18" />
      <path d="M9.5 21h5" />
      <path d="M12 17.5V21" />
    </svg>,
    // 托盘常驻（铃铛）
    <svg {...common}>
      <path d="M6.3 9a5.7 5.7 0 0 1 11.4 0c0 5.2 2.3 6.6 2.3 6.6H4s2.3-1.4 2.3-6.6Z" />
      <path d="M9.9 19.6a2.1 2.1 0 0 0 4.2 0" />
      <path d="M3 17.4h18" />
    </svg>,
    // Node 探测（雷达/搜索）
    <svg {...common}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
      <path d="M11 7.5a3.5 3.5 0 0 0-3.5 3.5" />
    </svg>,
    // 锁定版本（箱子+锁定点）
    <svg {...common}>
      <path d="M21 8.5v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
      <path d="M3.5 9.5 12 4.5l8.5 5" />
      <circle cx="12" cy="13" r="2.4" />
      <path d="M12 10.6V9" />
    </svg>,
    // 进程监护（心跳）
    <svg {...common}>
      <path d="M3 12h4l2.2-6 3.6 12 2.2-6H21" />
    </svg>,
    // 自动更新（循环箭头）
    <svg {...common}>
      <path d="M20 12a8 8 0 1 1-2.34-5.66" />
      <path d="M20.5 3.5v4h-4" />
    </svg>,
  ];
  return icons[index] ?? null;
}

export function Features() {
  const { t } = useI18n();
  return (
    <section className="section" id="features">
      <div className="container">
        <SectionHead label={t.features.label} title={t.features.title} lead={t.features.lead} />
        <div className="feat-grid">
          {t.features.items.map((item, i) => (
            <Reveal key={item.t} delay={(i % 3) * 80}>
              <article className="feat-card">
                <span className="feat-card__icon">
                  <FeatureIcon index={i} />
                </span>
                <h3 className="feat-card__title">{item.t}</h3>
                <p className="feat-card__desc">{item.d}</p>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}