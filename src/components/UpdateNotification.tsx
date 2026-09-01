import { useTranslation } from "react-i18next";
import { Info, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUpdate } from "@/contexts/UpdateContext";

interface UpdateNotificationProps {
  onViewDetails: () => void;
}

/** 轻量级更新通知横幅：检测到新版本时在主内容区顶部显示 */
export function UpdateNotification({ onViewDetails }: UpdateNotificationProps) {
  const { t } = useTranslation();
  const { hasUpdate, updateInfo, isDismissed, dismissUpdate } = useUpdate();

  if (!hasUpdate || isDismissed || !updateInfo) return null;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-primary/20 bg-primary/5 px-4 py-2.5 text-sm backdrop-blur-sm">
      <Info className="h-4 w-4 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 text-foreground">
        {t("update.notification", {
          defaultValue: "原生 CC-Switch 有新版本",
        })}{" "}
        <span className="font-semibold text-primary">
          v{updateInfo.availableVersion}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={onViewDetails}
          className="h-7 gap-1 px-2 text-xs font-medium text-primary hover:bg-primary/10"
        >
          {t("update.viewDetails", { defaultValue: "查看详情" })}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={dismissUpdate}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
