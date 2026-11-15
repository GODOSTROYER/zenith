import { Skeleton } from "@/components/ui/skeleton";
import styles from "./screen-loading.module.css";

export type ScreenLoadingVariant =
  | "page" | "overview" | "cards" | "canvas"
  | "list" | "editor" | "settings" | "conversation";

interface ScreenLoadingProps {
  label?: string;
  variant?: ScreenLoadingVariant;
}

const ROW_WIDTHS = ["62%", "78%", "54%", "70%", "58%"];
const CODE_WIDTHS = ["44%", "72%", "60%", "84%", "52%", "68%", "38%", "76%"];

function Rows({ count = 5 }: { count?: number }) {
  return (
    <div className={styles.rows}>
      {ROW_WIDTHS.slice(0, count).map((width, index) => (
        <div className={styles.row} key={index}>
          <Skeleton width={28} height={28} round />
          <div className={styles.rowText}>
            <Skeleton width={width} height={12} />
            <Skeleton width="38%" height={9} />
          </div>
          <Skeleton width={52} height={18} />
        </div>
      ))}
    </div>
  );
}

function Facts() {
  return (
    <div className={styles.facts}>
      {[0, 1, 2].map((index) => (
        <div key={index} className={styles.fact}>
          <Skeleton width={84} height={10} />
          <Skeleton width={64} height={27} />
          <Skeleton width="70%" height={9} />
        </div>
      ))}
    </div>
  );
}

function Content({ variant }: { variant: ScreenLoadingVariant }) {
  switch (variant) {
    case "overview":
      return <>
        <Facts />
        <div className={styles.columns}>
          <div className={styles.panel}><Rows /></div>
          <div className={styles.panel}><Skeleton width="60%" height={14} /><Rows count={3} /></div>
        </div>
      </>;
    case "cards":
      return <div className={styles.cards}>
        {[0, 1, 2, 3].map((index) => (
          <div className={styles.card} key={index}>
            <Skeleton width={36} height={36} />
            <Skeleton width="56%" height={17} />
            <Skeleton width="86%" height={11} />
            <div className={styles.cardFooter}><Skeleton width={72} height={18} /><Skeleton width={42} height={10} /></div>
          </div>
        ))}
      </div>;
    case "canvas":
      return <>
        <div className={styles.toolbar}><Skeleton width={144} height={32} /><Skeleton width={80} height={32} /></div>
        <div className={styles.canvas}>
          {[0, 1, 2].map((index) => (
            <div className={styles.mapNode} key={index}>
              <Skeleton width={24} height={24} /><Skeleton width="76%" height={12} /><Skeleton width="56%" height={9} />
            </div>
          ))}
        </div>
      </>;
    case "editor":
      return <>
        <div className={styles.toolbar}><Skeleton width={110} height={27} /><Skeleton width={94} height={27} /><Skeleton width={64} height={27} /></div>
        <div className={styles.editor}>
          {CODE_WIDTHS.map((width, index) => (
            <div className={styles.codeLine} key={index}><Skeleton width={14} height={10} /><Skeleton width={width} height={11} /></div>
          ))}
        </div>
      </>;
    case "settings":
      return <div className={styles.settings}>
        <div className={styles.sectionRail}>
          {["76%", "62%", "88%", "68%"].map((width) => <Skeleton key={width} width={width} height={13} />)}
        </div>
        <div className={styles.panel}>
          <Skeleton width="35%" height={18} />
          {[0, 1, 2].map((index) => (
            <div className={styles.field} key={index}><Skeleton width={100} height={11} /><Skeleton height={36} /></div>
          ))}
        </div>
      </div>;
    case "conversation":
      return <div className={styles.conversation}>
        <div className={styles.conversationRail}><Rows count={3} /></div>
        <div className={styles.messages}>
          <div className={styles.message}><Skeleton width="72%" height={12} /><Skeleton width="92%" height={11} /><Skeleton width="56%" height={11} /></div>
          <div className={styles.reply}><Skeleton width="88%" height={12} /><Skeleton width="62%" height={11} /></div>
          <Skeleton className={styles.composer} height={48} />
        </div>
      </div>;
    case "list":
      return <>
        <div className={styles.toolbar}><Skeleton width={180} height={32} /><Skeleton width={88} height={32} /></div>
        <div className={styles.panel}><Rows /></div>
      </>;
    default:
      return <div className={styles.panel}>
        <Skeleton width="68%" height={16} /><Skeleton width="88%" height={11} /><Skeleton width="76%" height={11} />
        <div className={styles.pageBody}><Rows count={3} /></div>
      </div>;
  }
}

/**
 * Route-local fallbacks: Next keeps the navigation and project chrome mounted.
 * No click interception, overlay, or minimum display time; ready content wins immediately.
 */
export function ScreenLoading({ label = "page", variant = "page" }: ScreenLoadingProps) {
  return (
    <div className={styles.screen} data-screen-loading={variant}>
      {/* Keep the announcement outside the busy region so it is not deferred. */}
      <p role="status" aria-live="polite" aria-atomic="true" className={styles.status}>
        <span className={styles.statusDot} aria-hidden="true" />
        Loading {label}…
      </p>
      <div aria-busy="true">
        <div aria-hidden="true" className={styles.content}>
          <div className={styles.heading}>
            <Skeleton width={220} height={30} />
            <Skeleton width="min(80%, 460px)" height={12} />
          </div>
          <Content variant={variant} />
        </div>
      </div>
    </div>
  );
}
