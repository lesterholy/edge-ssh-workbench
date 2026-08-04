import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Env } from "../env";
import { routeProfiles } from "./profiles";

const mocks = vi.hoisted(() => ({
  requireAuthentication: vi.fn(),
  createProfile: vi.fn(),
  listProfiles: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuthentication: mocks.requireAuthentication,
}));

vi.mock("../storage/profiles", () => ({
  ProfileRepository: class {
    createFromRequest = mocks.createProfile;
    listPage = mocks.listProfiles;
  },
}));

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    SSH_TRANSPORT: "direct",
    ALLOWED_SSH_PORTS: "22",
    ...overrides,
  } as Env;
}

describe("profile HTTP routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAuthentication.mockResolvedValue({ ownerId: "11111111-1111-4111-8111-111111111111" });
  });

  it("rejects a profile port outside the configured allowlist before storing it", async () => {
    const request = new Request("https://workbench.test/api/profiles", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Blocked port",
        host: "ssh.example.test",
        port: 7022,
        username: "root",
        notes: "",
        terminalType: "xterm-256color",
        encoding: "utf-8",
        initialCommand: null,
        credential: { method: "password", persistence: "prompt" },
      }),
    });

    await expect(routeProfiles(request, testEnv(), "/api/profiles")).rejects.toMatchObject({
      name: "TargetValidationError",
      code: "PROHIBITED_PORT",
    });
    expect(mocks.createProfile).not.toHaveBeenCalled();
  });

  it("returns a validation error for a malformed opaque page cursor", async () => {
    mocks.listProfiles.mockRejectedValue(new Error("Invalid pagination cursor"));
    const request = new Request("https://workbench.test/api/profiles?cursor=malformed");

    await expect(routeProfiles(request, testEnv(), "/api/profiles")).rejects.toMatchObject({
      status: 400,
      code: "VALIDATION_FAILED",
    });
  });
});
