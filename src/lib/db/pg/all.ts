/**
 * Every Postgres-backed collection and delegate group, imported for their
 * registration side effects in FK order. postgres-store.ts imports this one
 * file; packages never edit each other.
 */
import "./core";
import "./history";
import "./audit";
import "./alerts";
