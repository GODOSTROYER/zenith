/**
 * Gimbal's curated guide for the public page.
 *
 * Every answer here was written by hand against what the product actually
 * ships, and the page says so: this is a curated guide, not a live model.
 * Navigator's authenticated planning endpoint is not exposed to anonymous
 * visitors, and no answer on this page can execute anything.
 *
 * Suggestions and walkthroughs read the shared landing state, so what Gimbal
 * offers always matches the chapter and the selection in front of the visitor.
 */
import { fmtUsd } from "@/lib/format";
import type { AutonomyLevel } from "@/lib/domain/types";
import type { GimbalMood } from "@/components/navigator/gimbal-renderer";
import { AUTONOMY_LEVELS, AUTONOMY_MEANING } from "@/lib/navigator/shared";
import { chapterTitle, type ChapterId, type Highlight, type LandingState, type Suggestion } from "./landing-state";
import { AGENT_STEPS, ESTIMATE, NODE_META, PROPOSED_BINDING_IDS, PROPOSED_IDS, SCALE_STEPS, costDriver, nodeCost } from "./scenario";

/* --------------------------------- autonomy --------------------------------- */

export const AUTONOMY_NOTCH: Record<AutonomyLevel, number> = { observe: 1, plan: 2, approve: 3, bounded: 4, autonomous: 5 };

/** What each level means for a visitor, beside the exact policy line. */
export const AUTONOMY_GLOSS: Record<AutonomyLevel, string> = {
  observe: "Explain and suggest, without preparing or executing plans.",
  plan: "Prepare a plan for a person to inspect and run.",
  approve: "Execute steps only after the required approval.",
  bounded: "Handle permitted low-risk steps; never silently execute higher-risk work.",
  autonomous: "Execute within your permitted policies and budgets, not with unlimited authority.",
};

/**
 * The example request "Add a processing queue between the API and the worker",
 * as the policy implementation would actually treat it at each level.
 * Adding the queue, the worker and the bindings are low-risk edits to the
 * working copy; deploying is a high-risk step and follows the environment's
 * approval policy whatever the level.
 */
export const AUTONOMY_EXAMPLE: Record<AutonomyLevel, string> = {
  observe: "Explains what a queue would change and suggests the steps. Writes no plan, executes nothing.",
  plan: "Writes the plan: queue, worker, connections. You run it yourself. Executes nothing.",
  approve: "Prepares the plan and executes each step only after you approve it and press Run.",
  bounded: "Low-risk edits may run when you press Run. The deploy is high-risk, so this level refuses it.",
  autonomous: "Runs its whole plan inside your limits once you press Run. Every step is still recorded.",
};

export const moodForAutonomy = (level: AutonomyLevel): GimbalMood =>
  level === "observe" || level === "plan" ? "attentive" : level === "approve" ? "idle" : level === "bounded" ? "engaged" : "delighted";

/* -------------------------------- walkthroughs -------------------------------- */

export interface WalkthroughStep {
  chapter: ChapterId;
  text: (state: LandingState) => string;
  highlight: (state: LandingState) => Highlight | null;
  mood?: GimbalMood;
}
export interface Walkthrough {
  id: string;
  title: string;
  steps: WalkthroughStep[];
}

const label = (id: keyof typeof NODE_META) => NODE_META[id].label;

export const WALKTHROUGHS: Record<string, Walkthrough> = {
  overview: {
    id: "overview", title: "What you are looking at",
    steps: [
      { chapter: "before", text: () => "This is an application as Zenith sees it: a public address, a service, the storage and database it uses, and every connection between them, each one explained.", highlight: () => ({ nodes: ["public-route", "upload-api", "uploads", "results"] }) },
      { chapter: "before", text: () => "The highlighted parts are proposed. They do not exist yet; Zenith shows the change before anything runs, with its cost and risk.", highlight: () => ({ nodes: PROPOSED_IDS, bindings: PROPOSED_BINDING_IDS }), mood: "engaged" },
    ],
  },
  "why-queue": {
    id: "why-queue", title: "Why this system uses a queue",
    steps: [
      { chapter: "before", text: () => "This queue lets uploads arrive without forcing processing to happen immediately. Work waits here until a worker is free.", highlight: () => ({ nodes: ["process-jobs"], bindings: ["api-jobs", "worker-jobs"] }) },
      { chapter: "before", text: () => "The upload API only records the job and answers right away. Without the queue it would process every file before responding, so slow files made slow responses.", highlight: () => ({ nodes: ["upload-api"], bindings: ["api-jobs"] }) },
      { chapter: "before", text: () => "Workers take jobs at their own pace. When the queue grows, you add workers; the API and the visitors never wait for that decision.", highlight: () => ({ nodes: ["process-worker"], bindings: ["worker-jobs", "worker-uploads", "worker-results"] }), mood: "pleased" },
    ],
  },
  "read-plan": {
    id: "read-plan", title: "How to read this plan",
    steps: [
      { chapter: "before", text: () => "Two additions: the queue and the worker. Each item carries the product’s own explanation and a risk label. Both are low risk: nothing existing is touched.", highlight: () => ({ items: ["resource:process-jobs", "service:process-worker"], nodes: PROPOSED_IDS }) },
      { chapter: "before", text: () => "Four new connections. A connection is explicit: it says which service may publish, consume, read or write, and Zenith injects that configuration for you.", highlight: () => ({ items: PROPOSED_BINDING_IDS.map((id) => `binding:${id}`), bindings: PROPOSED_BINDING_IDS }) },
      { chapter: "before", text: () => `The estimate moves from ${fmtUsd(ESTIMATE.current)} to ${fmtUsd(ESTIMATE.proposed)} a month, ${fmtUsd(ESTIMATE.delta, { sign: true })}. It is a static estimate for this configuration, shown before anything runs.`, highlight: () => ({ region: "estimate" }), mood: "pleased" },
    ],
  },
  "cost-driver": {
    id: "cost-driver", title: "What drives this estimate",
    steps: [
      { chapter: "scenarios", text: (state) => { const step = SCALE_STEPS[state.scale]; const driver = costDriver(step.manifest); return `At ${step.uploadsPerDay} uploads a day, ${label(driver).toLowerCase()} drives most of the estimate: ${fmtUsd(nodeCost(step.manifest, driver))} of ${fmtUsd(step.estimate)} a month.`; }, highlight: (state) => ({ nodes: [costDriver(SCALE_STEPS[state.scale].manifest)], region: "estimate" }) },
      { chapter: "scenarios", text: () => "That number rests on the assumptions listed under the controls: how long a job takes and how much a replica handles. Change the assumption and the configuration changes with it. Zenith prices the configuration; the assumptions are this page’s.", highlight: () => ({ region: "assumptions" }), mood: "attentive" },
    ],
  },
  linking: {
    id: "linking", title: "Linking and approval",
    steps: [
      { chapter: "agents", text: () => "Linking starts in your terminal and finishes in your browser. You check the code, sign in, and choose the workspace, projects and scopes. Read is the minimum; write and publish are yours to grant.", highlight: () => ({ steps: [1, 2] }) },
      { chapter: "agents", text: () => "Then the agent works: it reads the real workspace and prepares an exact change, with a digest of what would run.", highlight: () => ({ steps: [3] }) },
      { chapter: "agents", text: () => "Nothing executes until you approve that exact digest in the browser. The agent cannot approve its own work, and linking on its own deploys nothing.", highlight: () => ({ steps: [4, 5] }), mood: "pleased" },
    ],
  },
  path: {
    id: "path", title: "What this path offers today",
    steps: [
      { chapter: "cloud", text: () => "AWS is the one cloud in preview today: Zenith plans your system for it and exports real Terraform, but never applies to your account. The sandbox and LocalStack are what run today.", highlight: () => ({ region: "aws" }) },
      { chapter: "cloud", text: () => "Zenith-managed hosting is a product vision, not a service: in development, not offered on tryzenith.cloud. Google Cloud, Azure and Kubernetes are planned; Oracle comes later.", highlight: () => ({ region: "managed" }), mood: "attentive" },
    ],
  },
  autonomy: {
    id: "autonomy", title: "What this level means",
    steps: [
      { chapter: "gimbal", text: (state) => `Level ${AUTONOMY_NOTCH[state.autonomy]}, ${state.autonomy}: ${AUTONOMY_MEANING[state.autonomy]} ${AUTONOMY_EXAMPLE[state.autonomy]}`, highlight: (state) => ({ level: state.autonomy }) },
      { chapter: "gimbal", text: () => "Changing this selector changes only this explanation. In the product the level is a workspace-wide setting an admin chooses, and Claude Code or Codex keep their own browser-approval rule whatever it says.", highlight: () => ({ region: "boundaries" }), mood: "attentive" },
    ],
  },
  ownership: {
    id: "ownership", title: "What you can take with you",
    steps: [
      { chapter: "close", text: () => "The infrastructure definition, real Terraform for AWS and an operations guide leave with you. None of them needs Zenith to run.", highlight: () => ({ region: "exports" }), mood: "pleased" },
    ],
  },
};

export function currentWalkthroughStep(state: LandingState): WalkthroughStep | null {
  if (!state.walkthrough) return null;
  return WALKTHROUGHS[state.walkthrough.id]?.steps[state.walkthrough.step] ?? null;
}

/** The presentation emphasis in force right now, or none. */
export function activeHighlight(state: LandingState): Highlight | null {
  return currentWalkthroughStep(state)?.highlight(state) ?? null;
}

/* --------------------------------- suggestions --------------------------------- */

const suggestion = (chapter: ChapterId, id: string, prompt: string, accept: string, walkthrough: string): Suggestion => ({ id, chapter, prompt, accept, walkthrough });

/** One contextual offer per chapter. Offered once, dismissed for the session. */
export const SUGGESTIONS: Partial<Record<ChapterId, Suggestion>> = {
  hero: suggestion("hero", "hero-overview", "Want a quick tour of the system?", "Show me", "overview"),
  agents: suggestion("agents", "agents-linking", "Want me to explain how linking and approval work?", "Show me", "linking"),
  before: suggestion("before", "before-queue", "Want to know why this system uses a queue?", "Tell me", "why-queue"),
  scenarios: suggestion("scenarios", "scenarios-driver", "Want to see what drives the estimate at this scale?", "Show me", "cost-driver"),
  cloud: suggestion("cloud", "cloud-path", "Want to know which of these works today?", "Yes", "path"),
  gimbal: suggestion("gimbal", "gimbal-level", "Want to see what this level means for a real request?", "Show me", "autonomy"),
};

/* ----------------------------------- topics ----------------------------------- */

export interface Topic {
  id: string;
  question: string;
  keywords: string[];
  answer: string;
  more?: string;
  /** an optional visual walkthrough the answer can open */
  show?: { chapter: ChapterId; walkthrough?: string; label: string };
  mood?: GimbalMood;
}

export const TOPICS: Topic[] = [
  { id: "what-is-zenith", question: "What is Zenith?", keywords: ["zenith", "product", "platform", "overview", "explain"],
    answer: "Zenith is a deployment and operations platform for the application you’re building. It turns your app into infrastructure you can see: the architecture, each proposed change, the estimated cost and the risks appear before anything runs, and the same view stays with you after you deploy.",
    more: "Today it plans and runs against a simulated sandbox or LocalStack on your machine, and exports real Terraform for AWS. Kubernetes, Google Cloud and Azure are planned.",
    show: { chapter: "before", walkthrough: "why-queue", label: "Show me the system" } },
  { id: "agent-deployment", question: "How does agent deployment work?", keywords: ["agent", "claude", "codex", "plugin", "link", "linking", "mcp", "terminal", "approve", "approval"],
    answer: "You keep Claude Code or Codex. Install the Zenith plugin, link it to your account in the browser, and choose which workspace, projects and scopes it may use. The agent prepares an exact change; you approve that exact change in the browser; only then does it execute and report what happened. It cannot approve its own work.",
    more: "Phase 1: deployments through the plugin run on the simulated sandbox provider. LocalStack and AWS through the plugin are planned.",
    show: { chapter: "agents", walkthrough: "linking", label: "Show the sequence" } },
  { id: "before-deployment", question: "What happens before deployment?", keywords: ["before", "plan", "review", "change", "diff", "risk", "cost", "estimate", "deploy"],
    answer: "You see the architecture with every connection explained, a plan that lists what a change would add, update or remove, a risk label per item, and the estimated monthly cost before and after. Nothing runs until you review and approve that plan.",
    show: { chapter: "before", walkthrough: "read-plan", label: "Read the plan with me" } },
  { id: "own-aws", question: "Can I use my own AWS account?", keywords: ["aws", "amazon", "account", "own", "cloud", "terraform", "apply", "credentials"],
    answer: "In preview. Zenith plans your system for AWS and exports real, runnable Terraform, but it does not apply changes to your account, read it or verify it. You run the export with your own tools. In-app AWS apply is not available yet.",
    show: { chapter: "cloud", walkthrough: "path", label: "Show me the roadmap" } },
  { id: "simulation", question: "How does simulation work?", keywords: ["simulation", "simulate", "simulated", "sandbox", "forecast", "scenario", "growth", "traffic", "scale", "users"],
    answer: "Two different things carry that word. The sandbox provider simulates deployments end to end, with labelled logs and timings, so you can rehearse the whole workflow without provisioning anything. The growth scenarios on this page are different: illustrative sizing rules, priced with Zenith’s estimate tables. Zenith does not forecast traffic today.",
    show: { chapter: "scenarios", walkthrough: "cost-driver", label: "Show what drives the estimate" } },
  { id: "gimbal-control", question: "How much control can Gimbal have?", keywords: ["control", "gimbal", "autonomy", "autonomous", "level", "levels", "permission", "permissions", "delegate", "bounded", "observe"],
    answer: `You choose one of five autonomy levels: ${AUTONOMY_LEVELS.join(", ")}. Below approve I never execute anything. At every level, execution starts from your Run action, each executed step is recorded, and deployments still obey each environment’s approval policy.`,
    more: "Claude Code and Codex have their own rule: every write they propose is approved in the browser, whatever my autonomy level says.",
    show: { chapter: "gimbal", walkthrough: "autonomy", label: "Explain the selected level" } },
  { id: "export", question: "Can I export my infrastructure?", keywords: ["export", "portability", "portable", "leave", "lock-in", "lock", "terraform", "own", "ownership", "readme"],
    answer: "Yes. Zenith exports the typed infrastructure definition, real Terraform for AWS and LocalStack, and an operations guide that explains how to keep operating without Zenith. Nothing in the export needs Zenith to run.",
    show: { chapter: "close", walkthrough: "ownership", label: "Show the exports" } },
  { id: "managed", question: "What does “managed by Zenith” mean?", keywords: ["managed", "hosted", "hosting", "host", "manage", "private", "address"],
    answer: "It is the intended second path: Zenith builds a supported app from a pinned recipe, serves it at a private address, checks its health, keeps its logs and controls who can open it. It is in development and not offered on tryzenith.cloud yet. Today, Zenith connects to a sandbox, LocalStack or, in preview, AWS.",
    show: { chapter: "cloud", walkthrough: "path", label: "Show me the roadmap" } },
  { id: "observability", question: "What can I see after deployment?", keywords: ["after", "observe", "observability", "logs", "log", "health", "monitor", "monitoring", "drift", "alerts", "alert", "running", "investigate"],
    answer: "What is running and which revision, health per service, logs, drift between the deployed revision and the provider, alert rules, and the full deployment history with rollback. On the sandbox those signals are simulated and labelled; drift is real on LocalStack." },
  { id: "navigator", question: "Is Navigator different from Gimbal?", keywords: ["navigator", "gimbal", "character", "mascot", "name", "difference"],
    answer: "Same thing, two names. Inside the product, the planning and execution surface is called Navigator; Gimbal is the character you see. When Navigator is planning, waiting for approval, applying, verified or blocked, I show that state with a label and an icon, never with a mood." },
  { id: "kubernetes", question: "Do you support Kubernetes?", keywords: ["kubernetes", "k8s", "cluster", "gcp", "google", "azure", "oracle", "planned"],
    answer: "Not yet. Kubernetes is planned as a deployment target, an environment you already run, not another cloud vendor. Zenith cannot connect to a cluster today, and it says so before any plan is written. Google Cloud and Azure are planned too; Oracle Cloud comes later.",
    show: { chapter: "cloud", label: "See what’s available" } },
  { id: "pricing", question: "How much does Zenith cost?", keywords: ["price", "pricing", "cost", "pay", "fee", "free", "bill", "billing", "money"],
    answer: "Zenith has no published pricing. Every dollar figure on this page is an infrastructure estimate from Zenith’s static estimate tables for the example configuration: not Zenith’s fee, not a bill and not a quote from any provider." },
  { id: "compliance", question: "Does Zenith handle GDPR or compliance?", keywords: ["gdpr", "compliance", "compliant", "privacy", "legal", "region", "regional", "residency", "soc"],
    answer: "No. Compliance assistance is a roadmap item: it could surface privacy, regional or GDPR-related considerations for a person to review. Zenith does not determine which laws apply, does not certify anything and does not automate compliance." },
  { id: "live-ai", question: "Are you a live AI?", keywords: ["ai", "live", "real", "model", "llm", "chatbot", "bot", "human", "curated"],
    answer: "On this page, no. My answers are written by the Zenith team and matched to your question, so they reflect what actually ships. Inside the product, Navigator plans through typed actions; an optional model only rewrites your request into that grammar, and nothing here can execute anything." },
  { id: "get-started", question: "How do I get started?", keywords: ["start", "started", "begin", "sign", "signup", "account", "onboarding", "try", "demo"],
    answer: "Create an account, then Gimbal walks you through a workspace, a starting point and a first system: a blueprint, a Docker Compose import or a blank project. Nothing is deployed until you choose to deploy it.", mood: "pleased" },
];

/** Suggested questions per chapter, in the order the chips appear. */
export const CHAPTER_TOPICS: Record<ChapterId, string[]> = {
  hero: ["what-is-zenith", "get-started", "live-ai"],
  agents: ["agent-deployment", "gimbal-control", "get-started"],
  before: ["before-deployment", "what-is-zenith", "export"],
  scenarios: ["simulation", "pricing", "before-deployment"],
  cloud: ["own-aws", "managed", "kubernetes"],
  gimbal: ["gimbal-control", "navigator", "agent-deployment"],
  close: ["export", "compliance", "get-started"],
};

export const topicById = (id: string | null | undefined): Topic | null => TOPICS.find((t) => t.id === id) ?? null;

const STOP = new Set(["the", "a", "an", "to", "of", "and", "or", "in", "on", "for", "with", "my", "i", "can", "how", "it", "this", "that", "is", "are", "do", "does", "me", "we", "you", "your", "what", "which", "like", "about", "tell", "please"]);
const tokens = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((t) => t && !STOP.has(t));

/** Match a typed question to a curated topic, or null when nothing fits. */
export function matchTopic(question: string): Topic | null {
  const words = tokens(question);
  if (!words.length) return null;
  let best: { topic: Topic; score: number } | null = null;
  for (const topic of TOPICS) {
    const keys = new Set(topic.keywords.filter((k) => !STOP.has(k)));
    const phrase = new Set(tokens(topic.question));
    let score = 0;
    for (const word of words) {
      if (keys.has(word)) score += 2;
      else if (phrase.has(word)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) best = { topic, score };
  }
  return best && best.score >= 2 ? best.topic : null;
}

export const NO_ANSWER = "I don’t have a written answer for that yet. Try one of the questions below, or sign in and open the workspace guide.";

/* --------------------------------- context line --------------------------------- */

/** What Gimbal says it is looking at. Explicit page state, never a guess about intent. */
export function contextLine(state: LandingState): string {
  const title = chapterTitle(state.chapter);
  switch (state.chapter) {
    case "before": return `${title} · ${state.view === "proposed" ? "proposed change" : "current system"} · ${label(state.selected)}`;
    case "scenarios": { const step = SCALE_STEPS[state.scale]; return `${title} · ${step.uploadsPerDay} uploads a day · ${fmtUsd(step.estimate)} a month`; }
    case "agents": return `${title} · step ${state.agentStep + 1}: ${AGENT_STEPS[state.agentStep].title}`;
    case "cloud": return `${title} · roadmap`;
    case "gimbal": return `${title} · level ${AUTONOMY_NOTCH[state.autonomy]}, ${state.autonomy}`;
    case "close": return `${title} · exports and roadmap`;
    default: return `${title} · welcome`;
  }
}
