import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fixture } from "../../../packages/hosting/test/database.ts";
import { createAuth } from "../src/server/auth.ts";
import { sessionAuth } from "../src/server/session-auth.ts";
import type { Env } from "../src/server/env.ts";

const secret = "quota-test-secret-with-at-least-32-characters";
function headers(token: string, key = secret) {
  return new Headers({
    cookie: `better-auth.session_token=${encodeURIComponent(`${token}.${createHmac("sha256", key).update(token).digest("base64")}`)}`,
  });
}
export async function sessionFixture() {
  const f = fixture();
  for (const id of ["1", "2"]) {
    await f.store.enroll({ account: id, version: crypto.randomUUID(), ciphertext: "x".repeat(64) });
    f.db
      .prepare(
        "INSERT INTO session(id,user_id,token,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)",
      )
      .run(id, `heybox:${id}`, `token-${id}`, Date.now() + 3600000, Date.now(), Date.now());
  }
  const env = {
    DB: f.adapter,
    SITE_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: secret,
  } as unknown as Env;
  return { ...f, env };
}

test("cached session reader matches login auth, isolates concurrent users and immediately sees revocation", async () => {
  const f = await sessionFixture();
  try {
    const original = createAuth(f.env, {
      waitUntil: () => assert.fail("reading must not schedule login work"),
    });
    const auth = sessionAuth(f.env);
    assert.equal(auth, sessionAuth({ ...f.env }));
    for (const token of ["token-1", "token-2", "unknown"])
      assert.deepEqual(
        await auth.api.getSession({ headers: headers(token) }),
        await original.api.getSession({ headers: headers(token) }),
      );
    const sessions = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        auth.api.getSession({ headers: headers(`token-${(i % 2) + 1}`) }),
      ),
    );
    assert.deepEqual(
      sessions.map((s) => s?.user.id),
      Array.from({ length: 20 }, (_, i) => `heybox:${(i % 2) + 1}`),
    );
    assert.equal(await auth.api.getSession({ headers: headers("token-1", "wrong-key") }), null);
    f.db.prepare("DELETE FROM session WHERE id=?").run("1");
    assert.equal(await auth.api.getSession({ headers: headers("token-1") }), null);
    assert.equal((await auth.api.getSession({ headers: headers("token-2") }))?.user.id, "heybox:2");
    f.db.prepare("UPDATE session SET expires_at=? WHERE id=?").run(Date.now() - 1, "2");
    assert.equal(await auth.api.getSession({ headers: headers("token-2") }), null);
    assert.equal(await auth.api.getSession({ headers: new Headers() }), null);
    assert.notEqual(auth, sessionAuth({ ...f.env, BETTER_AUTH_SECRET: secret + "-rotated" }));
    assert.equal(
      await sessionAuth({ ...f.env, BETTER_AUTH_SECRET: secret + "-rotated" }).api.getSession({
        headers: headers("token-1"),
      }),
      null,
    );
  } finally {
    f.close();
  }
});
