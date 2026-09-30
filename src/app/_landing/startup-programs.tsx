import Image from "next/image";
import s from "./startup-programs.module.css";

/** Program participation is separate from cloud availability and integrations. */
export function StartupPrograms() {
  return <section className={s.section} aria-labelledby="startup-programs-title">
    <div className={s.content}>
      <p className={s.eyebrow}>Building Zenith with support from</p>
      <h2 id="startup-programs-title">Accepted into startup programs.</h2>
      <ul className={s.programs}>
        <li><div className={s.brand}><Image src="/cloud-logos/aws.svg" alt="AWS" width={82} height={48} unoptimized /></div><p>AWS Activate</p></li>
        <li><div className={`${s.brand} ${s.combined}`}><span><Image src="/startup-programs/databricks.svg" alt="" width={27} height={27} unoptimized />Databricks</span><span><Image src="/startup-programs/neon.svg" alt="" width={27} height={27} unoptimized />Neon</span></div><p>Databricks / Neon</p></li>
        <li><div className={s.brand}><Image src="/startup-programs/mongodb.svg" alt="" width={26} height={38} unoptimized /><span>MongoDB</span></div><p>MongoDB for Startups</p></li>
        <li><div className={s.brand}><Image src="/startup-programs/intercom.svg" alt="" width={34} height={34} unoptimized /><span>Intercom</span></div><p>Intercom Early Stage</p></li>
        <li><div className={s.brand}><Image src="/startup-programs/supermemory.svg" alt="" width={32} height={28} unoptimized /><span>Supermemory</span></div><p>Supermemory</p></li>
      </ul>
    </div>
  </section>;
}
