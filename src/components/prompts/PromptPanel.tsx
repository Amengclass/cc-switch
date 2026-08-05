import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react";
import { toast } from "sonner";
import { type AppId } from "@/lib/api";
import { usePromptActions } from "@/hooks/usePromptActions";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import PromptListItem from "./PromptListItem";
import PromptFormPanel from "./PromptFormPanel";
import { ConfirmDialog } from "../ConfirmDialog";
import { listRemotePrompts, saveRemotePrompts, type RemotePrompt } from "@/lib/api/remote";

interface PromptPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
  /** 选中远端目标时，Prompts 直接编辑该主机 ~/.claude/CLAUDE.md */
  remoteTargetId?: string;
  /** 目标细化到 Docker 容器时，编辑容器内 ~/.claude/CLAUDE.md */
  remoteContainerId?: string;
}

export interface PromptPanelHandle {
  openAdd: () => void;
}

const PromptPanel = React.forwardRef<PromptPanelHandle, PromptPanelProps>(
  ({ open, appId, remoteTargetId, remoteContainerId }, ref) => {
    const { t } = useTranslation();
    const isRemote = Boolean(remoteTargetId && appId === "claude");

    const [isFormOpen, setIsFormOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [confirmDialog, setConfirmDialog] = useState<{
      isOpen: boolean;
      titleKey: string;
      messageKey: string;
      messageParams?: Record<string, unknown>;
      onConfirm: () => void;
    } | null>(null);

    // 本地：使用 DB hook
    const localActions = usePromptActions(appId);
    // 远端：自行管理状态
    const [remoteLoading, setRemoteLoading] = useState(false);
    const [remotePrompts, setRemotePrompts] = useState<Record<string, RemotePrompt>>({});

    const prompts = isRemote ? remotePrompts : localActions.prompts;
    const loading = isRemote ? remoteLoading : localActions.loading;

    const loadRemote = useCallback(async () => {
      if (!remoteTargetId) return;
      setRemoteLoading(true);
      try {
        const list = await listRemotePrompts(remoteTargetId, remoteContainerId || undefined);
        const map: Record<string, RemotePrompt> = {};
        list.forEach((p) => { map[p.id] = p; });
        setRemotePrompts(map);
      } catch (e) {
        toast.error(String(e));
      } finally {
        setRemoteLoading(false);
      }
    }, [remoteTargetId, remoteContainerId]);

    useEffect(() => {
      if (open) {
        if (isRemote) loadRemote();
        else localActions.reload();
      }
    }, [open, isRemote, loadRemote, localActions.reload]);

    // Listen for prompt import events from deep link
    useEffect(() => {
      const handlePromptImported = (event: Event) => {
        const customEvent = event as CustomEvent;
        if (customEvent.detail?.app === appId) {
          if (isRemote) loadRemote();
          else localActions.reload();
        }
      };
      window.addEventListener("prompt-imported", handlePromptImported);
      return () => window.removeEventListener("prompt-imported", handlePromptImported);
    }, [appId, isRemote, loadRemote, localActions.reload]);

    useTauriEvent("profile-applied", isRemote ? loadRemote : localActions.reload);

    const handleAdd = () => {
      setEditingId(null);
      setIsFormOpen(true);
    };

    React.useImperativeHandle(ref, () => ({
      openAdd: handleAdd,
    }));

    const handleEdit = (id: string) => {
      setEditingId(id);
      setIsFormOpen(true);
    };

    // 保存（新增/编辑），签名与 PromptFormPanel 的 onSave 匹配
    const handleSave = async (id: string, data: { name: string; content: string; description?: string; enabled?: boolean }) => {
      if (isRemote && remoteTargetId) {
        try {
          const list = Object.values(remotePrompts);
          if (editingId) {
            const idx = list.findIndex((p) => p.id === editingId);
            if (idx >= 0) {
              list[idx] = { ...list[idx], ...data, id: editingId, updatedAt: Date.now() };
            }
          } else {
            const newId = crypto.randomUUID();
            list.push({ id: newId, ...data, enabled: data.enabled ?? false, createdAt: Date.now(), updatedAt: Date.now() });
          }
          await saveRemotePrompts(remoteTargetId, list, remoteContainerId || undefined);
          // 同步更新前端状态
          const map: Record<string, RemotePrompt> = {};
          list.forEach((p) => { map[p.id] = p; });
          setRemotePrompts(map);
          toast.success(t("prompts.saveSuccess"), { closeButton: true });
        } catch (e) {
          toast.error(t("prompts.saveFailed"));
          throw e;
        }
        return;
      }
      await localActions.savePrompt(id, { id, ...data, enabled: data.enabled ?? false });
    };

    // 切换启用（与本地 usePromptActions.toggleEnabled 行为一致：乐观更新 + toast）
    const handleToggle = async (id: string, enabled: boolean) => {
      if (isRemote && remoteTargetId) {
        const prev = { ...remotePrompts };
        // 乐观更新：立即改 UI
        if (enabled) {
          const updated: Record<string, RemotePrompt> = {};
          Object.keys(remotePrompts).forEach((k) => {
            updated[k] = { ...remotePrompts[k], enabled: k === id };
          });
          setRemotePrompts(updated);
        } else {
          setRemotePrompts((p) => ({ ...p, [id]: { ...p[id], enabled: false } }));
        }
        try {
          const list = Object.values(enabled
            ? Object.keys(remotePrompts).reduce<Record<string, RemotePrompt>>((acc, k) => {
                acc[k] = { ...remotePrompts[k], enabled: k === id };
                return acc;
              }, {})
            : { ...remotePrompts, [id]: { ...remotePrompts[id], enabled: false } }
          );
          await saveRemotePrompts(remoteTargetId, list, remoteContainerId || undefined);
          toast.success(
            enabled ? t("prompts.enableSuccess") : t("prompts.disableSuccess"),
            { closeButton: true },
          );
        } catch (e) {
          setRemotePrompts(prev); // 回滚
          toast.error(enabled ? t("prompts.enableFailed") : t("prompts.disableFailed"));
        }
        return;
      }
      await localActions.toggleEnabled(id, enabled);
    };

    // 删除
    const handleDeletePrompt = (id: string) => {
      const prompt = prompts[id];
      setConfirmDialog({
        isOpen: true,
        titleKey: "prompts.confirm.deleteTitle",
        messageKey: "prompts.confirm.deleteMessage",
        messageParams: { name: prompt?.name },
        onConfirm: async () => {
          try {
            if (isRemote && remoteTargetId) {
              const list = Object.values(remotePrompts).filter((p) => p.id !== id);
              await saveRemotePrompts(remoteTargetId, list, remoteContainerId || undefined);
              // 同步更新前端状态
              setRemotePrompts((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
              toast.success(t("prompts.deleteSuccess"), { closeButton: true });
            } else {
              await localActions.deletePrompt(id);
            }
            setConfirmDialog(null);
          } catch (e) {
            toast.error(String(e));
          }
        },
      });
    };

    const promptEntries = useMemo(() => Object.entries(prompts), [prompts]);
    const enabledPrompt = promptEntries.find(([_, p]) => p.enabled);

    return (
      <div className="flex flex-col flex-1 min-h-0 px-6">
        <div className="flex-shrink-0 py-4 glass rounded-xl border border-white/10 mb-4 px-6">
          <div className="text-sm text-muted-foreground">
            {t("prompts.count", { count: promptEntries.length })} ·{" "}
            {enabledPrompt
              ? t("prompts.enabledName", { name: enabledPrompt[1].name })
              : t("prompts.noneEnabled")}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pb-16">
          {loading ? (
            <div className="text-center py-12 text-muted-foreground">
              {t("prompts.loading")}
            </div>
          ) : promptEntries.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto mb-4 bg-muted rounded-full flex items-center justify-center">
                <FileText size={24} className="text-muted-foreground" />
              </div>
              <h3 className="text-lg font-medium text-foreground mb-2">
                {t("prompts.empty")}
              </h3>
              <p className="text-muted-foreground text-sm">
                {t("prompts.emptyDescription")}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {promptEntries.map(([id, prompt]) => (
                <PromptListItem
                  key={id}
                  id={id}
                  prompt={prompt}
                  onToggle={handleToggle}
                  onEdit={handleEdit}
                  onDelete={handleDeletePrompt}
                />
              ))}
            </div>
          )}
        </div>

        {isFormOpen && (
          <PromptFormPanel
            appId={appId}
            editingId={editingId || undefined}
            initialData={editingId ? prompts[editingId] : undefined}
            onSave={handleSave}
            onClose={() => setIsFormOpen(false)}
          />
        )}

        {confirmDialog && (
          <ConfirmDialog
            isOpen={confirmDialog.isOpen}
            title={t(confirmDialog.titleKey)}
            message={t(confirmDialog.messageKey, confirmDialog.messageParams)}
            onConfirm={confirmDialog.onConfirm}
            onCancel={() => setConfirmDialog(null)}
          />
        )}
      </div>
    );
  },
);

PromptPanel.displayName = "PromptPanel";

export default PromptPanel;