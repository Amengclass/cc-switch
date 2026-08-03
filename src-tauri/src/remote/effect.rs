//! 供应商切换完成后,返回给前端的「生效方式」报告。

use serde::{Deserialize, Serialize};

/// 切换后的生效说明。原则:必须明确告知「在哪、以何种方式生效」,
/// 而不是只报「写入成功」。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectReport {
    /// 目标标识:本机为 "local",远程为 host 名称。
    pub target: String,
    /// 当前生效的供应商名称。
    pub provider_name: String,
    /// 已清理的冲突环境变量数量。
    pub conflicts_cleaned: usize,
    /// 面向用户的生效方式说明(每条一句,前端逐条展示)。
    pub notes: Vec<String>,
}
