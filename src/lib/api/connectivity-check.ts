import { invoke } from "@tauri-apps/api/core";
import type { AppId } from "./types";

// ===== 连通性检查类型 =====
// 注意：本检查只探测 base_url 是否可达，不发真实大模型请求，也不触碰故障转移熔断器。

export type HealthStatus = "operational" | "degraded" | "failed";

export interface StreamCheckResult {
  status: HealthStatus;
  success: boolean;
  message: string;
  responseTimeMs?: number;
  httpStatus?: number;
  testedAt: number;
  retryCount: number;
}

// ===== 连通性检查 API =====

/**
 * 连通性检查（单个供应商）
 */
export async function streamCheckProvider(
  appType: AppId,
  providerId: string,
): Promise<StreamCheckResult> {
  return invoke("stream_check_provider", { appType, providerId });
}

/**
 * 连通性检查（远端目标）：从该目标的 SSOT 取供应商 base_url 探测。
 * 与本机 streamCheckProvider 同构，只是数据源换成远端。
 */
export async function streamCheckRemoteProvider(
  hostId: string,
  app: string,
  providerId: string,
  container?: string,
): Promise<StreamCheckResult> {
  return invoke("stream_check_remote_provider", {
    hostId,
    app,
    providerId,
    container: container ?? null,
  });
}
