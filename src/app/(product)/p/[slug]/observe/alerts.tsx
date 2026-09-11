"use client";
/**
 * Re-export barrel. The banner, the section, its dialogs and the sentences
 * they share now live next door. Import those modules directly in new code.
 */
export { AlertBanner } from "./alert-banner";
export { AlertsCard } from "./alerts-card";
export { AckDialog, ChannelPicker, CreateDialog, EditDialog } from "./alert-dialogs";
export {
  effectiveThreshold,
  failedNames,
  ruleChannelLine,
  ruleLabel,
  type Kinds,
} from "./alert-labels";
