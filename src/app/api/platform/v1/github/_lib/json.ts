/** Small JSON helpers for the browser-only GitHub source routes (not a route module). */
import { NextResponse, type NextRequest } from "next/server";
import { GithubSourceError } from "@/lib/sources/github/types";

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
export function jsonResponse(body: unknown, init: { status?: number } = {}): NextResponse {
  return NextResponse.json(body, { status: init.status ?? 200, headers: HEADERS });
}
/** Exact content type, 2 KiB cap, strict object; anything else is invalid input. */
export async function readSmallJson(req: NextRequest): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw new GithubSourceError("invalid");
  if (req.nextUrl.searchParams.size) throw new GithubSourceError("invalid");
  const text = await req.text();
  if (text.length > 2048) throw new GithubSourceError("invalid");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new GithubSourceError("invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GithubSourceError("invalid");
  return value as Record<string, unknown>;
}
export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new GithubSourceError("invalid");
}
