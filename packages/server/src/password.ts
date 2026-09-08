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
  const [algorithm, salt, expectedHash, extra] = passwordHash.split(":");
  const expected = Buffer.from(expectedHash || "", "base64url");
  const valid = algorithm === "scrypt" && typeof salt === "string" &&
    salt.length > 0 && expected.length === keyLength && extra === undefined;
  const actual = Buffer.from(
    (await scrypt(password, valid ? salt : "pstack-invalid-password", keyLength)) as Buffer,
  );
  return valid && timingSafeEqual(actual, expected);
}
