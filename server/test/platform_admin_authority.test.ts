import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminAccounts } from "../src/modules/platformAdmin/accountsAdmin.js";
import { AdminAdmins } from "../src/modules/platformAdmin/admins.js";
import { PlatformAudit } from "../src/modules/platformAdmin/audit.js";
import type { AdminPrincipal } from "../src/modules/platformAdmin/auth.js";
import { readAdminAccountAuthority } from "../src/modules/platformAdmin/authority.js";
import { PlatformAdminStore } from "../src/modules/platformAdmin/store.js";
import { AdminUsers } from "../src/modules/platformAdmin/users.js";
import { MemoryMailer } from "./support/accounts.js";
import { consoleAdmin, type ConsoleAdmin } from "./support/adminConsole.js";
import { startServer, type Harness } from "./support/harness.js";

let h: Harness, first: ConsoleAdmin, second: ConsoleAdmin;
const reason = "Disposable mixed administrator authority race";
const meta = { requestId: "mixed-authority-fixture", ip: "127.0.0.1" };
beforeEach(async () => {
  const mailer = new MemoryMailer();
  h = await startServer(
    {
      ADMIN_CONSOLE_ORIGIN: "https://admin.example.test",
      TELEMETRY_TICK_MS: "0",
    },
    { mailer },
  );
  first = await consoleAdmin(h, mailer, "super_admin", "mixed-first");
  second = await consoleAdmin(h, mailer, "super_admin", "mixed-second");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.close();
});

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function services(
  resolve = (id: string) => readAdminAccountAuthority(h.ctx, id),
) {
  const store = new PlatformAdminStore(
    h.ctx.platform,
    h.ctx.ephemeral,
    resolve,
  );
  const audit = new PlatformAudit(h.ctx.platform);
  return {
    store,
    users: new AdminUsers(h.ctx, store, audit),
    accounts: new AdminAccounts(h.ctx, audit),
    admins: new AdminAdmins(h.ctx, store, audit),
  };
}
async function principal(
  admin: ConsoleAdmin,
  store: PlatformAdminStore,
): Promise<AdminPrincipal> {
  return {
    account: (await h.ctx.accounts.store.accountById(admin.account.accountId))!,
    grant: store.activeGrant(admin.account.accountId)!,
    session: store.activeSessions(admin.account.accountId, Date.now())[0]!,
  };
}
type Resource = "account" | "user";
async function prepare(resource: Resource) {
  if (resource === "user") {
    await first.account.setUpIdentity(`mixedfirst${Date.now().toString(36)}`);
    await second.account.setUpIdentity(`mixedsecond${Date.now().toString(36)}`);
  }
}
function suspend(
  resource: Resource,
  service: ReturnType<typeof services>,
  actor: AdminPrincipal,
) {
  return resource === "user"
    ? service.users.setSuspended(
        actor,
        second.account.userId,
        true,
        reason,
        meta,
      )
    : service.accounts.setSuspended(
        actor,
        second.account.accountId,
        true,
        reason,
        meta,
      );
}

describe("shared last usable administrator authority", () => {
  it.each<Resource>(["account", "user"])(
    "a pending %s suspension prevents an already-authenticated peer from demoting, revoking or resetting the actor",
    async (resource) => {
      await prepare(resource);
      const service = services();
      const [a, b] = await Promise.all([
        principal(first, service.store),
        principal(second, service.store),
      ]);
      const reserved = barrier(),
        proceed = barrier();
      const update = h.ctx.accounts.store.updateAccount.bind(
        h.ctx.accounts.store,
      );
      vi.spyOn(h.ctx.accounts.store, "updateAccount").mockImplementation(
        async (id, patch, at) => {
          if (id === second.account.accountId && patch.disabled_at != null) {
            reserved.release();
            await proceed.promise;
          }
          return update(id, patch, at);
        },
      );
      const pending = suspend(resource, service, a);
      try {
        await reserved.promise;
        expect(
          h.ctx.platform.get("platform_restrictions", {
            user_id: `account:${second.account.accountId}`,
          }),
        ).toBeDefined();
        // These principals were authenticated before the reservation, while the account row is still enabled.
        expect(
          (await h.ctx.accounts.store.accountById(second.account.accountId))!
            .disabled_at,
        ).toBeNull();
        await second.browser.expect(401, "GET", "/admin/v1/me");
        await expect(
          service.admins.changeRole(
            b,
            first.account.accountId,
            "auditor",
            reason,
            meta,
            a.grant.updated_at,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          service.admins.revoke(b, first.account.accountId, reason, meta),
        ).rejects.toMatchObject({ statusCode: 403 });
        await expect(
          service.admins.resetPasskeys(
            b,
            first.account.accountId,
            reason,
            meta,
          ),
        ).rejects.toMatchObject({ statusCode: 403 });
        expect(service.store.activeGrant(first.account.accountId)?.role).toBe(
          "super_admin",
        );
        expect(service.store.passkeys(first.account.accountId)).toHaveLength(1);
      } finally {
        proceed.release();
      }
      await pending;
      expect(
        (await h.ctx.accounts.store.accountById(first.account.accountId))!
          .disabled_at,
      ).toBeNull();
      expect(
        (await h.ctx.accounts.store.accountById(second.account.accountId))!
          .disabled_at,
      ).not.toBeNull();
    },
  );

  it.each([
    ["account", "demote"],
    ["account", "revoke"],
    ["account", "reset"],
    ["user", "demote"],
    ["user", "revoke"],
    ["user", "reset"],
  ] as const)(
    "a %s suspension rechecks authority when a concurrent %s wins after its snapshot",
    async (resource, mutation) => {
      await prepare(resource);
      const captured = barrier(),
        proceed = barrier();
      let paused = false;
      const original = h.ctx.accounts.store.accountById.bind(
        h.ctx.accounts.store,
      );
      let firstReads = 0;
      // resolve() is already complete because service calls hold captured principals. Pause at the actor's
      // account snapshot, then change its live grant/passkeys before the suspension enters its platform write.
      const normal = services();
      const [a, b] = await Promise.all([
        principal(first, normal.store),
        principal(second, normal.store),
      ]);
      vi.spyOn(h.ctx.accounts.store, "accountById").mockImplementation(
        async (id) => {
          const state = await original(id);
          if (id === first.account.accountId && ++firstReads === 1 && !paused) {
            paused = true;
            captured.release();
            await proceed.promise;
          }
          return state;
        },
      );
      const pending = suspend(resource, normal, a).then(
        () => ({ statusCode: 200 }),
        (error) => error,
      );
      try {
        await captured.promise;
        if (mutation === "demote")
          await normal.admins.changeRole(
            b,
            first.account.accountId,
            "auditor",
            reason,
            meta,
            a.grant.updated_at,
          );
        else if (mutation === "revoke")
          await normal.admins.revoke(b, first.account.accountId, reason, meta);
        else
          await normal.admins.resetPasskeys(
            b,
            first.account.accountId,
            reason,
            meta,
          );
      } finally {
        proceed.release();
      }
      expect(await pending).toMatchObject({ statusCode: 403 });
      expect(
        (await original(second.account.accountId))!.disabled_at,
      ).toBeNull();
      expect(
        h.ctx.platform.get("platform_restrictions", {
          user_id: `account:${second.account.accountId}`,
        }),
      ).toBeUndefined();
      expect(normal.store.activeGrant(second.account.accountId)?.role).toBe(
        "super_admin",
      );
      expect(normal.store.passkeys(second.account.accountId)).toHaveLength(1);
    },
  );
});
