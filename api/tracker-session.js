import crypto from "node:crypto";
export function sessionCodec(secret, ttlSeconds, now = () => Date.now()) {
  if (!secret || secret.length < 32)
    throw new Error("Set a dedicated SESSION_SECRET (at least 32 characters)");
  const sign = (value) =>
    crypto.createHmac("sha256", secret).update(value).digest("base64url");
  return {
    create(user) {
      if (!Number.isInteger(user.session_generation))
        throw new Error("Missing session generation");
      const value = Buffer.from(
        JSON.stringify({
          sub: user.id,
          generation: user.session_generation,
          exp: Math.floor(now() / 1000) + ttlSeconds,
        }),
      ).toString("base64url");
      return `${value}.${sign(value)}`;
    },
    verify(token) {
      if (!token || typeof token !== "string") return null;
      const parts = token.split(".");
      if (parts.length !== 2) return null;
      const expected = Buffer.from(sign(parts[0])),
        received = Buffer.from(parts[1]);
      if (
        expected.length !== received.length ||
        !crypto.timingSafeEqual(expected, received)
      )
        return null;
      try {
        const p = JSON.parse(Buffer.from(parts[0], "base64url").toString());
        return p.sub &&
          Number.isInteger(p.generation) &&
          Number.isFinite(p.exp) &&
          p.exp > Math.floor(now() / 1000)
          ? p
          : null;
      } catch {
        return null;
      }
    },
  };
}
export const sessionMatchesUser = (payload, user) =>
  Boolean(
    payload &&
      user &&
      String(payload.sub) === String(user.id) &&
      payload.generation === user.session_generation,
  );
