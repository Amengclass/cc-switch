import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { usePromptActions } from "@/hooks/usePromptActions";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import type { Prompt } from "@/lib/api";
import { listRemotePrompts, saveRemotePrompts, type RemotePrompt } from "@/lib/api/remote";
import PromptFormPanel from "./PromptFormPanel";
import { PromptLibrary } from "./PromptLibrary";
import {
  PiPromptTemplates,
  PiSystemPromptFiles,
  type PiPromptTemplatesHandle,
} from "./PiNativePromptResources";

export type PiPromptTab = "global" | "system" | "templates";
export type PromptPrimaryAction = "prompt" | "template" | null;

interface PiPromptPanelProps {
  open: boolean;
  remoteTargetId?: string;
  remoteContainerId?: string;
  onInteractionBlockedChange?: (blocked: boolean) => void;
  onNavigationBlockedChange?: (blocked: boolean) => void;
  onPrimaryActionChange?: (action: PromptPrimaryAction) => void;
}

export interface PiPromptPanelHandle {
  openAdd: () => void;
}

const actionForTab = (tab: PiPromptTab): PromptPrimaryAction => {
  if (tab === "global") return "prompt";
  if (tab === "templates") return "template";
  return null;
};

const PiPromptPanel = React.forwardRef<PiPromptPanelHandle, PiPromptPanelProps>(
  (
    {
      open,
      remoteTargetId,
      remoteContainerId,
      onInteractionBlockedChange,
      onNavigationBlockedChange,
      onPrimaryActionChange,
    },
    ref,
  ) => {
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<PiPromptTab>("global");
    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [deletingPrompt, setDeletingPrompt] = useState<Prompt | null>(null);
    const templatesRef = useRef<PiPromptTemplatesHandle>(null);

    const isRemote = Boolean(remoteTargetId);

    const {
      prompts: localPrompts,
      loading: localLoading,
      currentFileContent,
      togglingId,
      reload: localReload,
      savePrompt,
      deletePrompt,
      toggleEnabled,
    } = usePromptActions("pi");

    // 远端模式：listRemotePrompts + saveRemotePrompts（与 StandardPromptPanel 远端模式一致）
    const [remotePrompts, setRemotePrompts] = useState<Record<string, RemotePrompt>>({});
    const [remoteLoading, setRemoteLoading] = useState(false);

    const loadRemote = useCallback(async () => {
      if (!remoteTargetId) return;
      setRemoteLoading(true);
      try {
        const list = await listRemotePrompts(
          remoteTargetId,
          remoteContainerId || undefined,
          "pi",
        );
        const map: Record<string, RemotePrompt> = {};
        list.forEach((p) => { map[p.id] = p; });
        setRemotePrompts(map);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setRemoteLoading(false);
      }
    }, [remoteTargetId, remoteContainerId]);

    const prompts = isRemote ? remotePrompts : localPrompts;
    const loading = isRemote ? remoteLoading : localLoading;
    const dialogOpen = deletingPrompt !== null;
    const writePending = Boolean(togglingId);
    const interactionBlocked =
      loading || writePending || isFormOpen || dialogOpen || remoteLoading;
    const navigationBlocked = writePending || isFormOpen || dialogOpen;

    useEffect(() => {
      if (open && !isRemote) void localReload();
    }, [open, isRemote, localReload]);
    useEffect(() => {
      if (open && isRemote) void loadRemote();
    }, [open, isRemote, loadRemote]);

    useEffect(() => {
      onPrimaryActionChange?.(actionForTab(activeTab));
    }, [activeTab, onPrimaryActionChange]);

    useEffect(() => {
      onInteractionBlockedChange?.(interactionBlocked);
    }, [interactionBlocked, onInteractionBlockedChange]);

    useEffect(() => {
      onNavigationBlockedChange?.(navigationBlocked);
    }, [navigationBlocked, onNavigationBlockedChange]);

    useEffect(
      () => () => {
        onInteractionBlockedChange?.(false);
        onNavigationBlockedChange?.(false);
      },
      [onInteractionBlockedChange, onNavigationBlockedChange],
    );

    useEffect(() => {
      const handlePromptImported = (event: Event) => {
        const customEvent = event as CustomEvent;
        if (customEvent.detail?.app === "pi") {
          if (isRemote) void loadRemote();
          else void localReload();
        }
      };

      window.addEventListener("prompt-imported", handlePromptImported);
      return () =>
        window.removeEventListener("prompt-imported", handlePromptImported);
    }, [isRemote, localReload, loadRemote]);

    useTauriEvent("profile-applied", () => {
      if (isRemote) void loadRemote();
      else void localReload();
    });

    const openGlobalPromptForm = (id?: string) => {
      setEditingId(id ?? null);
      setIsFormOpen(true);
    };

    React.useImperativeHandle(
      ref,
      () => ({
        openAdd: () => {
          if (activeTab === "global") {
            openGlobalPromptForm();
          } else if (activeTab === "templates") {
            templatesRef.current?.openCreate();
          }
        },
      }),
      [activeTab],
    );

    const promptEntries = Object.entries(prompts);
    const activePrompt = promptEntries.find(([, prompt]) => prompt.enabled);
    const hasExternalPrompt =
      currentFileContent !== null && activePrompt === undefined;
    const handleDelete = async () => {
      if (!deletingPrompt) return;
      try {
        if (isRemote && remoteTargetId) {
          const list = Object.values(remotePrompts).filter(
            (p) => p.id !== deletingPrompt.id,
          );
          await saveRemotePrompts(
            remoteTargetId,
            list,
            remoteContainerId || undefined,
            "pi",
          );
          setRemotePrompts((prev) => {
            const next = { ...prev };
            delete next[deletingPrompt.id];
            return next;
          });
          toast.success(t("prompts.deleteSuccess"), { closeButton: true });
        } else {
          await deletePrompt(deletingPrompt.id);
          // usePromptActions owns the error toast.
        }
        setDeletingPrompt(null);
      } catch (error) {
        toast.error(t("prompts.deleteFailed"), { description: String(error) });
      }
    };

    return (
      <div className="flex min-h-0 flex-1 flex-col px-6">
        <Tabs
          value={activeTab}
          onValueChange={(value) => setActiveTab(value as PiPromptTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 py-4">
            <TabsList className="self-start">
              <TabsTrigger value="global">
                {t("pi.prompts.globalTab")}
              </TabsTrigger>
              <TabsTrigger value="system">
                {t("pi.prompts.systemTab")}
              </TabsTrigger>
              <TabsTrigger value="templates">
                {t("pi.prompts.templatesTab")}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent
            value="global"
            className="m-0 min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
          >
            <PromptLibrary
              prompts={prompts}
              loading={loading}
              searchQuery={searchQuery}
              statusText={
                activePrompt
                  ? t("prompts.enabledName", { name: activePrompt[1].name })
                  : hasExternalPrompt
                    ? t("pi.prompts.externalAgents")
                    : t("prompts.noneEnabled")
              }
              disabled={interactionBlocked}
              onSearchQueryChange={setSearchQuery}
              onToggle={async (id, enabled) => {
                if (isRemote && remoteTargetId) {
                  // 远端：乐观更新 + 写回远端
                  const prev = { ...remotePrompts };
                  if (enabled) {
                    const updated: Record<string, RemotePrompt> = {};
                    Object.keys(remotePrompts).forEach((k) => {
                      updated[k] = { ...remotePrompts[k], enabled: k === id };
                    });
                    setRemotePrompts(updated);
                  } else {
                    setRemotePrompts((p) => ({
                      ...p,
                      [id]: { ...p[id], enabled: false },
                    }));
                  }
                  try {
                    const list = Object.values(
                      enabled
                        ? Object.keys(remotePrompts).reduce<
                            Record<string, RemotePrompt>
                          >((acc, k) => {
                            acc[k] = { ...remotePrompts[k], enabled: k === id };
                            return acc;
                          }, {})
                        : {
                            ...remotePrompts,
                            [id]: { ...remotePrompts[id], enabled: false },
                          },
                    );
                    await saveRemotePrompts(
                      remoteTargetId,
                      list,
                      remoteContainerId || undefined,
                      "pi",
                    );
                    toast.success(
                      enabled
                        ? t("prompts.enableSuccess")
                        : t("prompts.disableSuccess"),
                      { closeButton: true },
                    );
                  } catch {
                    setRemotePrompts(prev); // 回滚
                    toast.error(
                      enabled ? t("prompts.enableFailed") : t("prompts.disableFailed"),
                    );
                  }
                  return;
                }
                void toggleEnabled(id, enabled).catch(() => undefined);
              }}
              onEdit={openGlobalPromptForm}
              onDelete={(id) => {
                const prompt = prompts[id];
                if (prompt) setDeletingPrompt(prompt);
              }}
              isDeleteDisabled={(_id, prompt) => prompt.enabled}
              getDeleteTitle={(_id, prompt) =>
                prompt.enabled
                  ? t("pi.prompts.stopBeforeDelete")
                  : t("common.delete")
              }
            />
          </TabsContent>

          <TabsContent
            value="system"
            className="m-0 min-h-0 flex-1 overflow-hidden"
          >
            <ScrollArea className="-mr-3 h-full" type="auto">
              <div className="pb-16 pr-3">
                <PiSystemPromptFiles
                  remoteTargetId={remoteTargetId}
                  remoteContainerId={remoteContainerId}
                />
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="templates" className="m-0 min-h-0 min-w-0 flex-1">
            <PiPromptTemplates
              ref={templatesRef}
              remoteTargetId={remoteTargetId}
              remoteContainerId={remoteContainerId}
            />
          </TabsContent>
        </Tabs>

        {isFormOpen && (
          <PromptFormPanel
            appId="pi"
            editingId={editingId ?? undefined}
            initialData={editingId ? prompts[editingId] : undefined}
            onSave={async (id, prompt) => {
              if (isRemote && remoteTargetId) {
                const list = Object.values(remotePrompts);
                if (editingId) {
                  const idx = list.findIndex((p) => p.id === editingId);
                  if (idx >= 0) {
                    list[idx] = {
                      ...list[idx],
                      ...prompt,
                      id: editingId,
                      updatedAt: Date.now(),
                    };
                  }
                } else {
                  list.push({
                    ...prompt,
                    id,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                  } as RemotePrompt);
                }
                await saveRemotePrompts(
                  remoteTargetId,
                  list,
                  remoteContainerId || undefined,
                  "pi",
                );
                const map: Record<string, RemotePrompt> = {};
                list.forEach((p) => { map[p.id] = p; });
                setRemotePrompts(map);
                toast.success(t("prompts.saveSuccess"), { closeButton: true });
                return true;
              }
              return savePrompt(id, prompt);
            }}
            onClose={() => setIsFormOpen(false)}
          />
        )}

        <ConfirmDialog
          isOpen={Boolean(deletingPrompt)}
          title={t("prompts.confirm.deleteTitle")}
          message={t("prompts.confirm.deleteMessage", {
            name: deletingPrompt?.name,
          })}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeletingPrompt(null)}
        />
      </div>
    );
  },
);

PiPromptPanel.displayName = "PiPromptPanel";

export default PiPromptPanel;
