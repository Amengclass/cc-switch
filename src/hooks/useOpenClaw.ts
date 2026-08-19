import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openclawApi } from "@/lib/api/openclaw";
import { providersApi } from "@/lib/api/providers";
import {
  getRemoteOpenClawEnv,
  setRemoteOpenClawEnv,
  getRemoteOpenClawTools,
  setRemoteOpenClawTools,
  getRemoteOpenClawAgentsDefaults,
  setRemoteOpenClawAgentsDefaults,
} from "@/lib/api/remote";
import type {
  OpenClawEnvConfig,
  OpenClawToolsConfig,
  OpenClawAgentsDefaults,
} from "@/types";

/**
 * Centralized query keys for all OpenClaw-related queries.
 * Import this from any file that needs to invalidate OpenClaw caches.
 */
export const openclawKeys = {
  all: ["openclaw"] as const,
  liveProviderIds: ["openclaw", "liveProviderIds"] as const,
  defaultModel: ["openclaw", "defaultModel"] as const,
  env: ["openclaw", "env"] as const,
  tools: ["openclaw", "tools"] as const,
  agentsDefaults: ["openclaw", "agentsDefaults"] as const,
  health: ["openclaw", "health"] as const,
};

// ============================================================
// Query hooks
// ============================================================

/**
 * Query live provider IDs from openclaw.json config.
 * Used by ProviderList to show "In Config" badge.
 */
export function useOpenClawLiveProviderIds(enabled: boolean) {
  return useQuery({
    queryKey: openclawKeys.liveProviderIds,
    queryFn: () => providersApi.getOpenClawLiveProviderIds(),
    enabled,
  });
}

/**
 * Query the default model from agents.defaults.model.
 * Used by ProviderList to show which provider is the default.
 */
export function useOpenClawDefaultModel(enabled: boolean) {
  return useQuery({
    queryKey: openclawKeys.defaultModel,
    queryFn: () => openclawApi.getDefaultModel(),
    enabled,
  });
}

/**
 * Query env section of openclaw.json.
 */
export function useOpenClawEnv(remoteTargetId?: string, remoteContainerId?: string) {
  return useQuery({
    queryKey: remoteTargetId
      ? ["openclaw", "env", remoteTargetId, remoteContainerId]
      : openclawKeys.env,
    queryFn: () =>
      remoteTargetId
        ? getRemoteOpenClawEnv(remoteTargetId, remoteContainerId)
        : openclawApi.getEnv(),
    staleTime: 30_000,
  });
}

/**
 * Query tools section of openclaw.json.
 */
export function useOpenClawTools(remoteTargetId?: string, remoteContainerId?: string) {
  return useQuery({
    queryKey: remoteTargetId
      ? ["openclaw", "tools", remoteTargetId, remoteContainerId]
      : openclawKeys.tools,
    queryFn: () =>
      remoteTargetId
        ? getRemoteOpenClawTools(remoteTargetId, remoteContainerId)
        : openclawApi.getTools(),
    staleTime: 30_000,
  });
}

/**
 * Query agents.defaults section of openclaw.json.
 */
export function useOpenClawAgentsDefaults(remoteTargetId?: string, remoteContainerId?: string) {
  return useQuery({
    queryKey: remoteTargetId
      ? ["openclaw", "agentsDefaults", remoteTargetId, remoteContainerId]
      : openclawKeys.agentsDefaults,
    queryFn: () =>
      remoteTargetId
        ? getRemoteOpenClawAgentsDefaults(remoteTargetId, remoteContainerId)
        : openclawApi.getAgentsDefaults(),
    staleTime: 30_000,
  });
}

export function useOpenClawHealth(enabled: boolean) {
  return useQuery({
    queryKey: openclawKeys.health,
    queryFn: () => openclawApi.scanHealth(),
    staleTime: 30_000,
    enabled,
  });
}

// ============================================================
// Mutation hooks
// ============================================================

/**
 * Save env config. Invalidates env query on success.
 * Toast notifications are handled by the component.
 */
export function useSaveOpenClawEnv(remoteTargetId?: string, remoteContainerId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (env: OpenClawEnvConfig) => {
      if (remoteTargetId) {
        await setRemoteOpenClawEnv(remoteTargetId, env, remoteContainerId);
      } else {
        await openclawApi.setEnv(env);
      }
    },
    onSuccess: () => {
      if (remoteTargetId) {
        queryClient.invalidateQueries({
          queryKey: ["openclaw", "env", remoteTargetId, remoteContainerId],
        });
      } else {
        queryClient.invalidateQueries({ queryKey: openclawKeys.env });
        queryClient.invalidateQueries({ queryKey: openclawKeys.health });
      }
    },
  });
}

/**
 * Save tools config. Invalidates tools query on success.
 * Toast notifications are handled by the component.
 */
export function useSaveOpenClawTools(remoteTargetId?: string, remoteContainerId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tools: OpenClawToolsConfig) => {
      if (remoteTargetId) {
        await setRemoteOpenClawTools(remoteTargetId, tools, remoteContainerId);
      } else {
        await openclawApi.setTools(tools);
      }
    },
    onSuccess: () => {
      if (remoteTargetId) {
        queryClient.invalidateQueries({
          queryKey: ["openclaw", "tools", remoteTargetId, remoteContainerId],
        });
      } else {
        queryClient.invalidateQueries({ queryKey: openclawKeys.tools });
        queryClient.invalidateQueries({ queryKey: openclawKeys.health });
      }
    },
  });
}

/**
 * Save agents.defaults config. Invalidates both agentsDefaults and defaultModel
 * queries on success (since changing agents.defaults may affect the default model).
 * Toast notifications are handled by the component.
 */
export function useSaveOpenClawAgentsDefaults(remoteTargetId?: string, remoteContainerId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (defaults: OpenClawAgentsDefaults) => {
      if (remoteTargetId) {
        await setRemoteOpenClawAgentsDefaults(remoteTargetId, defaults, remoteContainerId);
      } else {
        await openclawApi.setAgentsDefaults(defaults);
      }
    },
    onSuccess: () => {
      if (remoteTargetId) {
        queryClient.invalidateQueries({
          queryKey: ["openclaw", "agentsDefaults", remoteTargetId, remoteContainerId],
        });
        queryClient.invalidateQueries({
          queryKey: ["openclaw", "defaultModel", remoteTargetId, remoteContainerId],
        });
      } else {
        queryClient.invalidateQueries({ queryKey: openclawKeys.agentsDefaults });
        queryClient.invalidateQueries({ queryKey: openclawKeys.defaultModel });
        queryClient.invalidateQueries({ queryKey: openclawKeys.health });
      }
    },
  });
}
