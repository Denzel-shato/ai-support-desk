// Test-only stand-ins for the two deployment values. They are NOT secrets and NOT real addresses: they only
// exist so the Code-node tests can run with a configuration that the validators accept. Never reuse them.
const hex = (seed: number) => Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(i * 7 + seed * 5 + 3) % 16]).join("");

export const TEST_INBOX = "staff-inbox@acme-helpdesk-fixture.dev";
export const TEST_SALT = hex(1);
export const TEST_SALT_B = hex(2);

/** What the 'Deployment config' node emits for a valid configuration. */
export const validDeployment = (over: Record<string, unknown> = {}) => ({
  json: { deployment: { ok: true, errors: [], formSubmittedText: "x", escalationInbox: TEST_INBOX, rateLimitSalt: TEST_SALT, ...over } },
});
