import { env } from "./env";

export const sessionCookieName = env.SESSION_COOKIE_NAME;

export function bearerToken(request: Request) {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || undefined;
}

export function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  return cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function authToken(request: Request) {
  const cookieToken = cookieValue(request, sessionCookieName);
  return bearerToken(request) || (cookieToken ? decodeCookie(cookieToken) : undefined);
}

export function isCookieAuthenticatedRequest(request: Request) {
  return !bearerToken(request) && Boolean(cookieValue(request, sessionCookieName));
}

export function verifyRequestOrigin(request: Request) {
  if (
    request.method === "GET" ||
    request.method === "HEAD" ||
    !isCookieAuthenticatedRequest(request)
  )
    return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  const requestUrl = new URL(request.url);
  const acceptedOrigins = new Set([env.APP_ORIGIN || requestUrl.origin]);

  return acceptedOrigins.has(origin);
}

export function cookieSecureFlag() {
  const configured = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (configured === "true" || configured === "1") return " Secure;";
  if (configured === "false" || configured === "0") return "";
  const appOrigin = process.env.APP_ORIGIN?.trim();
  if (appOrigin) {
    try {
      return new URL(appOrigin).protocol === "https:" ? " Secure;" : "";
    } catch {
      // Invalid deployment origins fall back to the production default.
    }
  }
  return process.env.NODE_ENV === "production" ? " Secure;" : "";
}

export function setSessionCookie(response: Response, token: string) {
  response.headers.append(
    "set-cookie",
    `${sessionCookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Max-Age=${env.SESSION_TTL_SECONDS}; Path=/;${cookieSecureFlag()}`,
  );
  return response;
}

export function clearSessionCookie(response: Response) {
  response.headers.append(
    "set-cookie",
    `${sessionCookieName}=; HttpOnly; SameSite=Lax; Max-Age=0; Path=/;${cookieSecureFlag()}`,
  );
  return response;
}

function decodeCookie(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
