import { useCallback } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "@/lib/toast";
import { hermesApi } from "@/lib/api/hermes";
import {
  getRemoteHermesMemory,
  getRemoteHermesMemoryLimits,
  setRemoteHermesMemory,
  setRemoteHermesMemoryEnabled,
} from "@/lib/api/remote";
import { providersApi } from "@/lib/api/providers";
import { settingsApi } from "@/lib/api/settings";
import type { HermesMemoryKind } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";

/**
 * Error code returned by the Rust `open_hermes_web_ui` command when probing
 * `/api/status` fails. Must match the string constant in
 * `src-tauri/src/commands/hermes.rs`.
 */
export const HERMES_WEB_OFFLINE_ERROR = "hermes_web_offline";

/**
 * Centralized query keys for all Hermes-related queries.
 * Import this from any file that needs to invalidate Hermes caches.
 */
export const hermesKeys = {
  all: ["hermes"] as const,
  liveProviderIds: ["hermes", "liveProviderIds"] as const,
  modelConfig: ["hermes", "modelConfig"] as const,
  memory: (kind: HermesMemoryKind) => ["hermes", "memory", kind] as const,
  memoryLimits: ["hermes", "memoryLimits"] as const,
  configDir: ["hermes", "configDir"] as const,
};

/** 远端目标（本补丁层）：非空时记忆读写走远端。 */
export interface HermesRemoteTarget {
  remoteTargetId?: string;
  remoteContainerId?: string;
}

const scopedKey = (
  base: readonly unknown[],
  target?: HermesRemoteTarget,
): readonly unknown[] =>
  target?.remoteTargetId
    ? [...base, "remote", target.remoteTargetId, target.remoteContainerId ?? "__host__"]
    : base;

/**
 * Invalidate all Hermes caches that may change when a provider is
 * added/updated/deleted/switched. Runs invalidations in parallel so the
 * caller doesn't await three sequential refetches.
 */
export function invalidateHermesProviderCaches(queryClient: QueryClient) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: hermesKeys.liveProviderIds }),
    queryClient.invalidateQueries({ queryKey: hermesKeys.modelConfig }),
  ]);
}

// ============================================================
// Query hooks
// ============================================================

export function useHermesLiveProviderIds(enabled: boolean) {
  return useQuery({
    queryKey: hermesKeys.liveProviderIds,
    queryFn: () => providersApi.getHermesLiveProviderIds(),
    enabled,
  });
}

export function useHermesModelConfig(enabled: boolean) {
  return useQuery({
    queryKey: hermesKeys.modelConfig,
    queryFn: () => hermesApi.getModelConfig(),
    enabled,
  });
}

export function useHermesMemory(
  kind: HermesMemoryKind,
  enabled: boolean,
  target?: HermesRemoteTarget,
) {
  return useQuery({
    queryKey: scopedKey(hermesKeys.memory(kind), target),
    queryFn: () =>
      target?.remoteTargetId
        ? getRemoteHermesMemory(
            target.remoteTargetId,
            kind,
            target.remoteContainerId,
          )
        : hermesApi.getMemory(kind),
    enabled,
  });
}

export function useHermesMemoryLimits(enabled: boolean, target?: HermesRemoteTarget) {
  return useQuery({
    queryKey: scopedKey(hermesKeys.memoryLimits, target),
    queryFn: () =>
      target?.remoteTargetId
        ? getRemoteHermesMemoryLimits(
            target.remoteTargetId,
            target.remoteContainerId,
          )
        : hermesApi.getMemoryLimits(),
    staleTime: 60_000,
    enabled,
  });
}

/**
 * Hermes 的配置目录（设置里可改，也认 HERMES_HOME），记忆页用来显示
 * memories/MEMORY.md 的真实路径。
 */
export function useHermesConfigDir(enabled: boolean) {
  return useQuery({
    queryKey: hermesKeys.configDir,
    queryFn: () => settingsApi.getConfigDir("hermes"),
    staleTime: 60_000,
    enabled,
  });
}

// ============================================================
// Mutation hooks
// ============================================================

/**
 * Save a Hermes memory file atomically and refresh the corresponding query.
 * Error toasts are emitted here so caller components don't need their own
 * try/catch; success toasts are intentionally left to the caller (to pick
 * the right localized message per tab).
 */
export function useSaveHermesMemory(target?: HermesRemoteTarget) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: async ({
      kind,
      content,
    }: {
      kind: HermesMemoryKind;
      content: string;
    }) => {
      if (target?.remoteTargetId) {
        await setRemoteHermesMemory(
          target.remoteTargetId,
          kind,
          content,
          target.remoteContainerId,
        );
      } else {
        await hermesApi.setMemory(kind, content);
      }
    },
    onSuccess: async (_data, variables) => {
      await queryClient.invalidateQueries({
        queryKey: scopedKey(hermesKeys.memory(variables.kind), target),
      });
    },
    onError: (error) => {
      toast.error(t("hermes.memory.saveFailed"), {
        description: extractErrorMessage(error) || undefined,
      });
    },
  });
}

/**
 * Toggle one memory blob's on/off flag in Hermes' `config.yaml`. Invalidates
 * the limits query so the switch UI and disabled banner update immediately.
 */
export function useToggleHermesMemoryEnabled(target?: HermesRemoteTarget) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: async ({
      kind,
      enabled,
    }: {
      kind: HermesMemoryKind;
      enabled: boolean;
    }) => {
      if (target?.remoteTargetId) {
        await setRemoteHermesMemoryEnabled(
          target.remoteTargetId,
          kind,
          enabled,
          target.remoteContainerId,
        );
      } else {
        await hermesApi.setMemoryEnabled(kind, enabled);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: scopedKey(hermesKeys.memoryLimits, target),
      });
    },
    onError: (error) => {
      toast.error(t("hermes.memory.toggleFailed"), {
        description: extractErrorMessage(error) || undefined,
      });
    },
  });
}

/**
 * Returns a handler that probes the local Hermes Web UI, opens it in the
 * system browser, and surfaces a localized toast on failure. When
 * `onOffline` is provided, it replaces the default offline toast —
 * callers can use this to open a launch-dashboard confirm dialog instead.
 */
export function useOpenHermesWebUI(onOffline?: () => void) {
  const { t } = useTranslation();
  return useCallback(
    async (path?: string) => {
      try {
        await hermesApi.openWebUI(path);
      } catch (error) {
        const detail = extractErrorMessage(error);
        if (detail === HERMES_WEB_OFFLINE_ERROR) {
          if (onOffline) {
            onOffline();
          } else {
            toast.error(t("hermes.webui.offline"));
          }
        } else {
          toast.error(t("hermes.webui.openFailed"), {
            description: detail || undefined,
          });
        }
      }
    },
    [t, onOffline],
  );
}
