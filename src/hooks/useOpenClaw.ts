import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { openclawApi } from "@/lib/api/openclaw";
import {
  getRemoteOpenClawAgentsDefaults,
  getRemoteOpenClawEnv,
  getRemoteOpenClawTools,
  setRemoteOpenClawAgentsDefaults,
  setRemoteOpenClawEnv,
  setRemoteOpenClawTools,
} from "@/lib/api/remote";
import { providersApi } from "@/lib/api/providers";
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

/** 远端目标（本补丁层）：非空时该面板读写远端 openclaw.json。 */
export interface OpenClawRemoteTarget {
  remoteTargetId?: string;
  remoteContainerId?: string;
}

const scopedKey = (
  base: readonly unknown[],
  target?: OpenClawRemoteTarget,
): readonly unknown[] =>
  target?.remoteTargetId
    ? [...base, "remote", target.remoteTargetId, target.remoteContainerId ?? "__host__"]
    : base;

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
export function useOpenClawEnv(target?: OpenClawRemoteTarget) {
  return useQuery({
    queryKey: scopedKey(openclawKeys.env, target),
    queryFn: () =>
      target?.remoteTargetId
        ? getRemoteOpenClawEnv(target.remoteTargetId, target.remoteContainerId)
        : openclawApi.getEnv(),
    staleTime: 30_000,
  });
}

/**
 * Query tools section of openclaw.json.
 */
export function useOpenClawTools(target?: OpenClawRemoteTarget) {
  return useQuery({
    queryKey: scopedKey(openclawKeys.tools, target),
    queryFn: () =>
      target?.remoteTargetId
        ? getRemoteOpenClawTools(target.remoteTargetId, target.remoteContainerId)
        : openclawApi.getTools(),
    staleTime: 30_000,
  });
}

/**
 * Query agents.defaults section of openclaw.json.
 */
export function useOpenClawAgentsDefaults(target?: OpenClawRemoteTarget) {
  return useQuery({
    queryKey: scopedKey(openclawKeys.agentsDefaults, target),
    queryFn: () =>
      target?.remoteTargetId
        ? getRemoteOpenClawAgentsDefaults(
            target.remoteTargetId,
            target.remoteContainerId,
          )
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
export function useSaveOpenClawEnv(target?: OpenClawRemoteTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (env: OpenClawEnvConfig) => {
      if (target?.remoteTargetId) {
        await setRemoteOpenClawEnv(
          target.remoteTargetId,
          env,
          target.remoteContainerId,
        );
      } else {
        await openclawApi.setEnv(env);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: openclawKeys.env });
      queryClient.invalidateQueries({ queryKey: openclawKeys.health });
    },
  });
}

/**
 * Save tools config. Invalidates tools query on success.
 * Toast notifications are handled by the component.
 */
export function useSaveOpenClawTools(target?: OpenClawRemoteTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (tools: OpenClawToolsConfig) => {
      if (target?.remoteTargetId) {
        await setRemoteOpenClawTools(
          target.remoteTargetId,
          tools,
          target.remoteContainerId,
        );
      } else {
        await openclawApi.setTools(tools);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: openclawKeys.tools });
      queryClient.invalidateQueries({ queryKey: openclawKeys.health });
    },
  });
}

/**
 * Save agents.defaults config. Invalidates both agentsDefaults and defaultModel
 * queries on success (since changing agents.defaults may affect the default model).
 * Toast notifications are handled by the component.
 */
export function useSaveOpenClawAgentsDefaults(target?: OpenClawRemoteTarget) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (defaults: OpenClawAgentsDefaults) => {
      if (target?.remoteTargetId) {
        await setRemoteOpenClawAgentsDefaults(
          target.remoteTargetId,
          defaults,
          target.remoteContainerId,
        );
      } else {
        await openclawApi.setAgentsDefaults(defaults);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: openclawKeys.agentsDefaults });
      queryClient.invalidateQueries({ queryKey: openclawKeys.defaultModel });
      queryClient.invalidateQueries({ queryKey: openclawKeys.health });
    },
  });
}
