import { HttpClient } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

import type { AccountBudget, ControlToken, CreateTokenRequest, CreateTokenResponse, GlobalBudget, ProviderKeyRecord, ServerUsageStats, UserTokenUsage } from "../models/control-plane.models";
import type { TenantSpendSummary } from "../models/tenant-spend.types";

/** API gateway for control-plane dashboard endpoints. */
@Injectable({ providedIn: "root" })
export class ControlPlaneApiService
{
  private readonly _http = inject(HttpClient);
  private readonly _baseUrl = "/api";

  async getServerUsage(): Promise<ServerUsageStats>
  {
    return await firstValueFrom(this._http.get<ServerUsageStats>(`${this._baseUrl}/metrics/server`));
  }

  async getTokenUsage(): Promise<UserTokenUsage[]>
  {
    return await firstValueFrom(this._http.get<UserTokenUsage[]>(`${this._baseUrl}/token-usage`));
  }

  async getGlobalBudget(): Promise<GlobalBudget>
  {
    return await firstValueFrom(this._http.get<GlobalBudget>(`${this._baseUrl}/budgets/global`));
  }

  async updateGlobalBudget(payload: GlobalBudget): Promise<void>
  {
    await firstValueFrom(this._http.put(`${this._baseUrl}/budgets/global`, payload));
  }

  async getAccountBudgets(): Promise<AccountBudget[]>
  {
    return await firstValueFrom(this._http.get<AccountBudget[]>(`${this._baseUrl}/budgets/accounts`));
  }

  async upsertAccountBudget(payload: AccountBudget): Promise<void>
  {
    await firstValueFrom(this._http.put(`${this._baseUrl}/budgets/accounts/${encodeURIComponent(payload.userId)}`, payload));
  }

  async deleteAccountBudget(userId: string): Promise<void>
  {
    await firstValueFrom(this._http.delete(`${this._baseUrl}/budgets/accounts/${encodeURIComponent(userId)}`));
  }

  async getTenantSpend(tenantName: string): Promise<TenantSpendSummary>
  {
    return await firstValueFrom(this._http.get<TenantSpendSummary>(`${this._baseUrl}/spend/${encodeURIComponent(tenantName)}`));
  }

  async listTokens(): Promise<ControlToken[]>
  {
    return await firstValueFrom(this._http.get<ControlToken[]>(`${this._baseUrl}/access-tokens`));
  }

  async createToken(payload: CreateTokenRequest): Promise<CreateTokenResponse>
  {
    return await firstValueFrom(this._http.post<CreateTokenResponse>(`${this._baseUrl}/access-tokens`, payload));
  }

  async deleteToken(id: string): Promise<void>
  {
    await firstValueFrom(this._http.delete(`${this._baseUrl}/access-tokens/${encodeURIComponent(id)}`));
  }

  async listProviderKeys(): Promise<ProviderKeyRecord[]>
  {
    return await firstValueFrom(this._http.get<ProviderKeyRecord[]>(`${this._baseUrl}/providers/keys`));
  }

  async setProviderKey(provider: "openai" | "claude", value: string): Promise<void>
  {
    await firstValueFrom(this._http.put(`${this._baseUrl}/providers/keys/${provider}`, { value }));
  }

  async deleteProviderKey(provider: "openai" | "claude"): Promise<void>
  {
    await firstValueFrom(this._http.delete(`${this._baseUrl}/providers/keys/${provider}`));
  }
}
