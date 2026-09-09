import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
function scrypt(password: string, salt: string, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}
const keyLength = 64;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const derived = await scrypt(password, salt, keyLength);
  return `scrypt:${salt}:${derived.toString("base64url")}`;
}

export async function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, salt, expectedHash, extra] = passwordHash.split(":");
  const expected = Buffer.from(expectedHash || "", "base64url");
  const valid =
    algorithm === "scrypt" &&
    salt !== undefined &&
    salt.length > 0 &&
    expected.length === keyLength &&
    extra === undefined;
  const actual = await scrypt(password, valid ? salt : "pstack-invalid-password", keyLength);
  return valid && timingSafeEqual(actual, expected);
}
