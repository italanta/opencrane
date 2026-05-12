export interface ServerUsageStats
{
  cpuPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  storageUsedBytes: number;
  storageTotalBytes: number;
  activeTenants: number;
  sampledAt: string;
}

export interface UserTokenUsage
{
  userId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  currency: "USD" | "EUR";
  totalCost: number;
  budgetCeiling?: number;
}

export interface GlobalBudget
{
  currency: "USD" | "EUR";
  ceilingAmount: number;
}

export interface AccountBudget
{
  userId: string;
  currency: "USD" | "EUR";
  ceilingAmount: number;
}

export interface ControlToken
{
  id: string;
  name: string;
  owner: string;
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
}

export interface CreateTokenRequest
{
  name: string;
  owner: string;
  expiresAt?: string;
}

export interface CreateTokenResponse
{
  id: string;
  plainTextToken: string;
}

export interface ProviderKeyRecord
{
  provider: "openai" | "claude";
  configured: boolean;
  maskedValue?: string;
  updatedAt?: string;
}

export interface AuthenticatedUser
{
  sub: string;
  issuer: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  authenticatedAt: string;
}

export interface AuthStatusResponse
{
  mode: "development" | "oidc" | "token";
  authenticated: boolean;
  user: AuthenticatedUser | null;
}
