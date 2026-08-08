import type {
  TcgplayerAuthenticationRequiredHandler,
  TcgplayerSessionProvider,
} from "tcgplayer-private-api";
import { ConfigurationError } from "./errors.js";

export type SellerKeySource = string | (() => string);

export interface SellerCredentialAccess {
  readonly session: TcgplayerSessionProvider;
  readonly sellerKey: () => string;
  readonly onAuthenticationRequired: TcgplayerAuthenticationRequiredHandler;
  readonly isConnected: () => boolean;
}

export function resolveSellerKey(source: SellerKeySource): string {
  return typeof source === "function" ? source() : source;
}

export function environmentSellerCredentialAccess(
  authCookieEnvironmentName: string,
  sellerKeyEnvironmentName: string,
  environment: NodeJS.ProcessEnv,
): SellerCredentialAccess {
  const authCookie = environment[authCookieEnvironmentName]?.trim();
  const sellerKey = environment[sellerKeyEnvironmentName]?.trim();
  if (!authCookie || !sellerKey) {
    throw new ConfigurationError([
      `Environment variables ${authCookieEnvironmentName} and ${sellerKeyEnvironmentName} are required.`,
    ]);
  }
  return {
    session: () => ({ authCookie }),
    sellerKey: () => sellerKey,
    onAuthenticationRequired: () => undefined,
    isConnected: () => true,
  };
}
