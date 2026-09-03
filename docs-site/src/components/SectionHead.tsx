import { Reveal } from "./Reveal";

interface SectionHeadProps {
  label: string;
  title: string;
  lead?: string;
}

export function SectionHead({ label, title, lead }: SectionHeadProps) {
  return (
    <Reveal className="sec-head">
      <p className="eyebrow">{label}</p>
      <h2 className="h2">{title}</h2>
      {lead ? <p className="lead">{lead}</p> : null}
    </Reveal>
  );
}