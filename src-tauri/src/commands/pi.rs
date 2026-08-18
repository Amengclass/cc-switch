use crate::provider::UsageScript;
use crate::services::pi_state::{PiCurrentState, PiStateService};
use crate::services::ProviderService;
use crate::session_manager::providers::pi::PiSessionDiscovery;
use crate::store::AppState;
use tauri::State;

#[tauri::command]
pub(crate) fn get_pi_current_state(state: State<'_, AppState>) -> Result<PiCurrentState, String> {
    PiStateService::current(state.inner()).map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn update_pi_provider_usage_script(
    state: State<'_, AppState>,
    id: String,
    #[allow(non_snake_case)] usageScript: UsageScript,
) -> Result<bool, String> {
    ProviderService::update_pi_usage_script(state.inner(), &id, usageScript)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn get_pi_session_discovery() -> PiSessionDiscovery {
    crate::session_manager::providers::pi::session_discovery()
}

/// 获取 Pi live 配置中的供应商 ID 列表
/// 用于前端判断供应商是否已添加到 models.json
#[tauri::command]
pub(crate) fn get_pi_live_provider_ids() -> Result<Vec<String>, String> {
    crate::pi_config::read_pi_native_providers()
        .map(|providers| providers.keys().cloned().collect())
        .map_err(|e| e.to_string())
}
