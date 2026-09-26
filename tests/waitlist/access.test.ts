import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/server/errors";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getUserById: vi.fn(),
  waitlistRepository: vi.fn(),
  admitted: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/waitlist/repository", () => ({ waitlistRepository: mocks.waitlistRepository }));

import { getWaitlistAccess, isWaitlistOperator, requireWaitlistAccess, waitlistGateEnabled } from "@/lib/waitlist/access";
import { waitlistConfig, waitlistEnabled } from "@/lib/waitlist/config";

const USER_ID = "10000000-0000-4000-8000-000000000001";
const OPERATOR_ID = "10000000-0000-4000-8000-000000000002";
const CUTOFF = "2026-09-26T00:00:00.000Z";
const CALLER = { id: USER_ID, email: "claimed@example.com" };
const CANONICAL_EMAIL = "verified@example.com";
const ENV_KEYS = [
  "ZENITH_WAITLIST_ENABLED",
  "ZENITH_WAITLIST_GATE_ENABLED",
  "ZENITH_WAITLIST_ADMIN_IDS",
  "ZENITH_WAITLIST_EXISTING_USERS_BEFORE",
  "ZENITH_WAITLIST_RATE_LIMIT_SECRET",
  "ZENITH_WAITLIST_TRUSTED_IP_HEADER",
] as const;

function canonical(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    email: CANONICAL_EMAIL,
    email_confirmed_at: "2026-09-26T00:00:02.000Z",
    created_at: "2026-09-26T00:00:01.000Z",
    ...overrides,
  };
}

function enableGate() {
  vi.stubEnv("ZENITH_WAITLIST_GATE_ENABLED", "1");
  vi.stubEnv("ZENITH_WAITLIST_EXISTING_USERS_BEFORE", CUTOFF);
}

beforeEach(() => {
  for (const key of ENV_KEYS) vi.stubEnv(key, undefined);
  vi.resetAllMocks();
  mocks.createAdminClient.mockReturnValue({ auth: { admin: { getUserById: mocks.getUserById } } });
  mocks.getUserById.mockResolvedValue({ data: { user: canonical() }, error: null });
  mocks.waitlistRepository.mockResolvedValue({ admitted: mocks.admitted });
  mocks.admitted.mockResolvedValue(false);
});
afterEach(() => vi.unstubAllEnvs());

describe("waitlist access authorization", () => {
  it.each([null, CALLER])("defaults to disabled without auth or database access for %j", async (user) => {
    expect(waitlistGateEnabled()).toBe(false);
    await expect(getWaitlistAccess(user)).resolves.toEqual({ allowed: true, reason: "disabled" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.getUserById).not.toHaveBeenCalled();
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });

  it("does not enable the gate when only public intake is enabled", async () => {
    vi.stubEnv("ZENITH_WAITLIST_ENABLED", "1");
    vi.stubEnv("ZENITH_WAITLIST_RATE_LIMIT_SECRET", "s".repeat(32));
    expect(waitlistEnabled()).toBe(true);
    expect(waitlistGateEnabled()).toBe(false);
    await expect(getWaitlistAccess(CALLER)).resolves.toEqual({ allowed: true, reason: "disabled" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });

  it("denies anonymous access when the gate is explicitly enabled", async () => {
    enableGate();
    await expect(getWaitlistAccess(null)).resolves.toEqual({ allowed: false, reason: "waiting" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });

  it("recognizes operators only by their configured immutable user ID", async () => {
    enableGate();
    vi.stubEnv("ZENITH_WAITLIST_ADMIN_IDS", ` ${OPERATOR_ID}, ${USER_ID} `);
    const operator = { id: OPERATOR_ID, email: "changed@example.com" };
    expect(isWaitlistOperator(operator)).toBe(true);
    expect(isWaitlistOperator(null)).toBe(false);
    await expect(getWaitlistAccess(operator)).resolves.toEqual({ allowed: true, reason: "operator" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });

  it.each(["admin", "editor", "viewer"])("does not let a workspace %s role or existing membership bypass admission", async (role) => {
    enableGate();
    vi.stubEnv("ZENITH_WAITLIST_ADMIN_IDS", OPERATOR_ID);
    const claimedMember = {
      ...CALLER,
      role,
      workspaceId: "existing-workspace",
      member: true,
      memberships: [{ workspaceId: "existing-workspace", role }],
      created_at: "2020-01-01T00:00:00.000Z",
      app_metadata: { role: "admin", waitlist_admitted: true },
      user_metadata: { role: "admin", waitlist_admitted: true },
    };
    mocks.getUserById.mockResolvedValue({
      data: { user: canonical({ app_metadata: claimedMember.app_metadata, user_metadata: claimedMember.user_metadata }) },
      error: null,
    });
    expect(isWaitlistOperator(claimedMember)).toBe(false);
    await expect(getWaitlistAccess(claimedMember)).resolves.toEqual({ allowed: false, reason: "waiting" });
    expect(mocks.getUserById).toHaveBeenCalledWith(USER_ID);
    expect(mocks.admitted).toHaveBeenCalledWith(CANONICAL_EMAIL);
  });

  it("grandfathers only the canonical account creation time before the fixed cutoff", async () => {
    enableGate();
    mocks.getUserById.mockResolvedValue({ data: { user: canonical({
      created_at: "2026-09-25T23:59:59.999Z",
      email: undefined,
      email_confirmed_at: undefined,
    }) }, error: null });
    const claimedNewAccount = { ...CALLER, created_at: "2099-01-01T00:00:00.000Z" };
    await expect(getWaitlistAccess(claimedNewAccount)).resolves.toEqual({ allowed: true, reason: "existing-account" });
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });

  it.each([CUTOFF, "2026-09-26T00:00:00.001Z", "invalid"])("does not grandfather canonical creation time %s", async (createdAt) => {
    enableGate();
    mocks.getUserById.mockResolvedValue({ data: { user: canonical({ created_at: createdAt }) }, error: null });
    const claimedOldAccount = { ...CALLER, created_at: "2020-01-01T00:00:00.000Z" };
    await expect(getWaitlistAccess(claimedOldAccount)).resolves.toEqual({ allowed: false, reason: "waiting" });
    expect(mocks.admitted).toHaveBeenCalledWith(CANONICAL_EMAIL);
  });

  it("checks admission using the canonical confirmed email instead of caller email", async () => {
    enableGate();
    mocks.admitted.mockImplementation(async (email: string) => email === CANONICAL_EMAIL);
    await expect(getWaitlistAccess(CALLER)).resolves.toEqual({ allowed: true, reason: "admitted" });
    expect(mocks.admitted).toHaveBeenCalledExactlyOnceWith(CANONICAL_EMAIL);
  });

  it("does not borrow admission from a caller-supplied email", async () => {
    enableGate();
    mocks.admitted.mockImplementation(async (email: string) => email === CALLER.email);
    await expect(getWaitlistAccess(CALLER)).resolves.toEqual({ allowed: false, reason: "waiting" });
    expect(mocks.admitted).not.toHaveBeenCalledWith(CALLER.email);
  });

  it.each([
    { email: undefined },
    { email: "" },
    { email_confirmed_at: undefined },
    { email_confirmed_at: "" },
  ])("denies a new account without a canonical confirmed email: %j", async (overrides) => {
    enableGate();
    mocks.getUserById.mockResolvedValue({ data: { user: canonical(overrides) }, error: null });
    mocks.admitted.mockResolvedValue(true);
    await expect(getWaitlistAccess(CALLER)).resolves.toEqual({ allowed: false, reason: "waiting" });
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });

  it.each([
    { name: "auth lookup error", data: { user: canonical() }, error: new Error("unavailable") },
    { name: "missing canonical user", data: { user: null }, error: null },
    { name: "mismatched canonical user", data: { user: canonical({ id: OPERATOR_ID }) }, error: null },
  ])("fails closed with 503 for $name", async ({ data, error }) => {
    enableGate();
    mocks.getUserById.mockResolvedValue({ data, error });
    await expect(getWaitlistAccess(CALLER)).rejects.toMatchObject({ name: "ApiError", status: 503 });
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });

  it.each(["identity transport", "admin client initialization"])("fails closed with a private retryable error when %s throws", async (source) => {
    enableGate();
    const detail = "private-provider-config-or-network-detail";
    if (source === "identity transport") mocks.getUserById.mockRejectedValue(new Error(detail));
    else mocks.createAdminClient.mockImplementation(() => { throw new Error(detail); });
    const check = getWaitlistAccess(CALLER);
    await expect(check).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
      message: "Access could not be verified. Please try again shortly.",
    });
    await expect(check).rejects.not.toThrow(detail);
    expect(mocks.waitlistRepository).not.toHaveBeenCalled();
  });
  it("rechecks admission after revocation and canonical email changes", async () => {
    enableGate();
    mocks.admitted.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    await expect(getWaitlistAccess(CALLER)).resolves.toMatchObject({ allowed: true });
    await expect(getWaitlistAccess(CALLER)).resolves.toEqual({ allowed: false, reason: "waiting" });
    mocks.getUserById.mockResolvedValue({ data: { user: canonical({ email: "changed@example.com" }) }, error: null });
    await expect(getWaitlistAccess(CALLER)).resolves.toEqual({ allowed: false, reason: "waiting" });
    expect(mocks.getUserById).toHaveBeenCalledTimes(3);
    expect(mocks.admitted).toHaveBeenNthCalledWith(3, "changed@example.com");
  });

  it("does not grant access if the admission repository fails", async () => {
    enableGate();
    mocks.admitted.mockRejectedValue(new ApiError("Admission unavailable", 503));
    await expect(getWaitlistAccess(CALLER)).rejects.toMatchObject({ status: 503 });
  });

  it("requires waiting users to open their status page with a 403", async () => {
    enableGate();
    await expect(requireWaitlistAccess(CALLER)).rejects.toMatchObject({
      name: "ApiError",
      status: 403,
      fix: "Open /waitlist to check access.",
    });
  });

  it("allows admitted users through the required-access guard", async () => {
    enableGate();
    mocks.admitted.mockResolvedValue(true);
    await expect(requireWaitlistAccess(CALLER)).resolves.toBeUndefined();
  });
});

describe("waitlist configuration", () => {
  it.each(["true", "yes", "2"])("rejects non-explicit gate opt-in %s", (value) => {
    vi.stubEnv("ZENITH_WAITLIST_GATE_ENABLED", value);
    expect(waitlistConfig).toThrow(/Invalid waitlist configuration/);
  });

  it("requires a fixed existing-account cutoff before enabling the gate", () => {
    vi.stubEnv("ZENITH_WAITLIST_GATE_ENABLED", "1");
    expect(waitlistConfig).toThrow(/existingUsersBefore/);
  });

  it.each(["yesterday", "2026-09-26", "2026-09-26T00:00:00"])("rejects invalid or timezone-free cutoff %s", (cutoff) => {
    vi.stubEnv("ZENITH_WAITLIST_EXISTING_USERS_BEFORE", cutoff);
    expect(waitlistConfig).toThrow(/existingUsersBefore/);
  });

  it("accepts an explicit cutoff with a timezone offset", () => {
    vi.stubEnv("ZENITH_WAITLIST_GATE_ENABLED", "1");
    vi.stubEnv("ZENITH_WAITLIST_EXISTING_USERS_BEFORE", "2026-09-26T05:30:00+05:30");
    expect(waitlistConfig()).toMatchObject({ gateEnabled: true, existingUsersBefore: "2026-09-26T05:30:00+05:30" });
  });

  it.each([undefined, "", "s".repeat(31)])("requires an intake rate-limit salt of at least 32 characters: %j", (secret) => {
    vi.stubEnv("ZENITH_WAITLIST_ENABLED", "1");
    vi.stubEnv("ZENITH_WAITLIST_RATE_LIMIT_SECRET", secret);
    expect(waitlistConfig).toThrow(/rateLimitSecret/);
  });

  it("accepts a 32-character private intake salt", () => {
    vi.stubEnv("ZENITH_WAITLIST_ENABLED", "1");
    vi.stubEnv("ZENITH_WAITLIST_RATE_LIMIT_SECRET", "s".repeat(32));
    expect(waitlistConfig()).toMatchObject({ enabled: true, rateLimitSecret: "s".repeat(32) });
  });

  it.each(["admin", "operator@example.com", `${OPERATOR_ID},invalid-id`])("rejects non-UUID operator IDs: %s", (ids) => {
    vi.stubEnv("ZENITH_WAITLIST_ADMIN_IDS", ids);
    expect(waitlistConfig).toThrow(/adminIds/);
  });

  it("does not expose the private salt in configuration errors", () => {
    const secret = "private-secret-too-short";
    vi.stubEnv("ZENITH_WAITLIST_ENABLED", "1");
    vi.stubEnv("ZENITH_WAITLIST_RATE_LIMIT_SECRET", secret);
    expect(waitlistConfig).toThrow(/rateLimitSecret/);
    expect(waitlistConfig).not.toThrow(secret);
  });
});
