import { useTranslation } from "react-i18next";
import { Server, RefreshCw } from "lucide-react";
import { Switch } from "@/components/ui/switch";

interface RemoteProviderSettingsProps {
  /** 是否每次读远端面板时自动读入该机器 live 的实际生效配置（default 卡） */
  value: boolean;
  onChange: (next: boolean) => void;
}

/**
 * 「远端设置」分组：存放远端宿主机/容器的供应商面板个性化选项。
 *
 * 当前唯一选项：非 additive app（claude/codex/gemini/grokbuild）的 default 卡
 * 是否每次刷新。开 = 随时可见当前机器实际生效配置（容器下每次读面板多一次
 * docker exec）；关 = 仅空库才导入，更快但看不到外部改动。
 * additive（opencode/openclaw/hermes）不受影响（live 即列表，必须同步）。
 * 后续远端个性化设置追加到本分组即可。
 */
export function RemoteProviderSettings({
  value,
  onChange,
}: RemoteProviderSettingsProps) {
  const { t } = useTranslation();
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2 pb-2 border-b border-border/40">
        <Server className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">
          {t("settings.section.remote", { defaultValue: "远端设置" })}
        </h3>
      </div>
      <p className="text-xs text-muted-foreground -mt-2">
        {t("settings.section.remoteHint", {
          defaultValue: "针对远端宿主机/容器的供应商面板行为",
        })}
      </p>
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card/50 p-4 transition-colors hover:bg-muted/50">
        <div className="flex items-start gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background ring-1 ring-border">
            <RefreshCw className="h-4 w-4 text-primary" />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium leading-none">
              {t("settings.remote.autoImportDefault.title", {
                defaultValue: "远端自动读入当前配置",
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.remote.autoImportDefault.description", {
                defaultValue:
                  "开启后将实时展示远端机器的当前应用配置（default 卡）；关闭后不再主动拉取最新配置，界面刷新更快。",
              })}
            </p>
            <p className="text-[11px] leading-snug text-muted-foreground/70">
              {t("settings.remote.autoImportDefault.note", {
                defaultValue:
                  "注：仅影响 Claude、Codex、Gemini、Grok Build；OpenCode、OpenClaw、Hermes 始终实时同步，不受影响。",
              })}
            </p>
          </div>
        </div>
        <Switch
          checked={value}
          onCheckedChange={onChange}
          aria-label={t("settings.remote.autoImportDefault.title", {
            defaultValue: "远端自动读入当前配置",
          })}
        />
      </div>
    </section>
  );
}
