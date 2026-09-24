"use client";

import Image from "next/image";
import { OrbitMark } from "@/components/shell/wordmark";
import { Glyph } from "./bento-visuals";
import styles from "./bento-cloud.module.css";

/** Existing local assets; no hotlinks, logo re-draws, or implied partnerships. */
export const CLOUD_BRANDS = [
  { id: "aws", name: "AWS", asset: "aws", width: 72, height: 44 },
  { id: "gcp", name: "Google Cloud", asset: "google-cloud", width: 50, height: 40 },
  { id: "azure", name: "Azure", asset: "azure", width: 40, height: 40 },
  { id: "kubernetes", name: "Kubernetes", asset: "kubernetes", width: 42, height: 42 },
  { id: "oracle", name: "Oracle Cloud", asset: "oracle", width: 88, height: 30 },
  { id: "localstack", name: "LocalStack", asset: "localstack", width: 42, height: 42 },
] as const;

export function CloudLogo({ id }: { id: string }) {
  const brand = CLOUD_BRANDS.find((item) => item.id === (id === "oracle-coming-later" ? "oracle" : id));
  if (!brand) return <span className={styles.environmentMark} aria-hidden="true"><Glyph name={id === "sandbox" ? "layers" : "globe"} /></span>;
  // Names are supplied by the surrounding figure/row; the image is not announced twice.
  // AWS/Oracle have square canvases around horizontal artwork: crop only empty canvas.
  return <Image src={`/cloud-logos/${brand.asset}.svg`} width={brand.width} height={brand.height}
    className={styles.logo} data-cloud-logo={brand.id} alt="" unoptimized
    style={brand.id === "aws" || brand.id === "oracle" ? { objectFit: "cover" } : undefined} />;
}

/** Three real infrastructure concepts resolve into one managed surface. */
export function ManagedHostingVisual() {
  return <div id="cloud-managed-visual" className={`${styles.scene} ${styles.managedScene}`} data-cloud-scene
    role="img" aria-label="Managed hosting concept: an app, compute and storage settle into one system managed by Zenith.">
    <div className={styles.managedArt} aria-hidden="true">
      <div className={`${styles.managedEnclosure} ${styles.animated}`} />
      <div className={`${styles.managedBrand} ${styles.animated}`}><OrbitMark size={34} /><span>zenith</span></div>
      <svg className={styles.managedWires} viewBox="0 0 360 330" fill="none" preserveAspectRatio="none">
        <path d="M180 165V190M180 190H97V215M180 190H263V215" />
        <path className={`${styles.managedTrace} ${styles.animated}`} pathLength="100" d="M180 165V190H97V215M180 190H263V215" />
      </svg>
      <div className={`${styles.appTile} ${styles.animated}`}><span><Glyph name="app" size={25} /></span><div><small>YOUR PRODUCT</small><b>App</b></div><i /></div>
      <div className={`${styles.computeTile} ${styles.serviceTile} ${styles.animated}`}><Glyph name="worker" size={22} /><span>Compute</span><i className={styles.computeLines}><i /><i /><i /></i></div>
      <div className={`${styles.storageTile} ${styles.serviceTile} ${styles.animated}`}><Glyph name="database" size={22} /><span>Storage</span><i className={styles.storageLines}><i /><i /><i /></i></div>
      <div className={`${styles.managedSeal} ${styles.animated}`}><Glyph name="check" size={14} />Managed by Zenith</div>
    </div>
  </div>;
}

/** Workload placement, not live request routing or a fabricated price comparison. */
export function MulticloudVisual() {
  return <div id="cloud-multicloud-visual" className={`${styles.scene} ${styles.multiScene}`} data-cloud-scene
    role="img" aria-label="Multicloud concept: Zenith connects AWS compute and Google Cloud storage in one system. This illustrates placement, not live routing or a cheapest-provider comparison.">
    <div className={styles.multiArt} aria-hidden="true">
      <div className={`${styles.multiCore} ${styles.animated}`}><OrbitMark size={27} /><span>Zenith</span></div>
      <svg className={styles.multiWires} viewBox="0 0 300 228" fill="none" preserveAspectRatio="none">
        <path d="M150 54V77C150 88 74 80 74 105V119M150 77C150 88 226 80 226 105V119" />
        <path className={`${styles.computeTrace} ${styles.animated}`} pathLength="100" d="M150 54V77C150 88 74 80 74 105V119" />
        <path className={`${styles.storageTrace} ${styles.animated}`} pathLength="100" d="M150 54V77C150 88 226 80 226 105V119" />
      </svg>
      <div className={`${styles.cloudDestination} ${styles.awsDestination} ${styles.animated}`}><CloudLogo id="aws" /><b>Compute</b><span>AWS</span></div>
      <div className={`${styles.cloudDestination} ${styles.gcpDestination} ${styles.animated}`}><CloudLogo id="gcp" /><b>Storage</b><span>Google Cloud</span></div>
      <div className={`${styles.systemBracket} ${styles.animated}`}><span>One system</span></div>
    </div>
  </div>;
}
