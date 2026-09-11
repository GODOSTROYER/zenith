/**
 * Manifest edits. Every one of these mutates the project's WORKING copy —
 * never a running environment — so their plans are pure changeset previews
 * and their results say "deploy to apply it".
 *
 * Importing a group registers its actions as a side effect, so the order of
 * these six lines is the catalog's registration order.
 */
import "./services";
import "./resources";
import "./routes";
import "./bindings";
import "./env-vars";
import "./secrets";

export { manifestAction } from "./shared";
