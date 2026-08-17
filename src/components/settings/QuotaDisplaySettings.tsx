import { useTranslation } from "react-i18next";
import { ToggleRow } from "@/components/ui/toggle-row";

interface QuotaDisplaySettingsProps {
  value: string;
  onChange: (mode: string) => void;
}

export function QuotaDisplaySettings({
  value,
  onChange,
}: QuotaDisplaySettingsProps) {
  const { t } = useTranslation();

  return (
    <section className="space-y-2">
      <header className="space-y-1">
        <h3 className="text-sm font-medium">
          {t("settings.quotaDisplay.title", {
            defaultValue: "套餐用量显示",
          })}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("settings.quotaDisplay.description", {
            defaultValue: "控制供应商卡片上套餐用量的显示格式",
          })}
        </p>
      </header>
      <ToggleRow
        title={t("settings.quotaDisplay.compact", {
          defaultValue: "紧凑模式",
        })}
        description={t("settings.quotaDisplay.compactDescription", {
          defaultValue:
            "以简洁格式显示套餐用量（如「5小时: 5%」），关闭则展开显示详细数据（总额/已用/剩余/重置时间）",
        })}
        checked={value === "compact"}
        onCheckedChange={(checked) =>
          onChange(checked ? "compact" : "expanded")
        }
      />
    </section>
  );
}
