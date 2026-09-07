import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, keyLength);
  return `scrypt:${salt}:${Buffer.from(derived as Buffer).toString("base64url")}`;
}

export async function verifyPassword(password: string, passwordHash: string) {
  if (!passwordHash.startsWith("scrypt:")) return false;
  const [, salt, expectedHash, extra] = passwordHash.split(":");
  if (!salt || !expectedHash || extra !== undefined) return false;
  const actual = Buffer.from(
    (await scrypt(password, salt, keyLength)) as Buffer,
  );
  const expected = Buffer.from(expectedHash, "base64url");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
