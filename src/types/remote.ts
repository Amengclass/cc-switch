/** 远程主机认证方式（M1 仅支持密码，密钥二期实现） */
export type RemoteAuthMethod = "password" | "key";

/** 远程主机（对应后端 remote::RemoteHost，camelCase 序列化） */
export interface RemoteHost {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: RemoteAuthMethod;
  savePassword: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 测试连接的返回信息 */
export interface RemoteConnectionInfo {
  connected: boolean;
  home: string;
  settingsExists: boolean;
  /** true=已安装,false=未安装,null=检测失败 */
  claudeCodeInstalled: boolean | null;
}

/** 新增/编辑主机的表单（不含 id 的输入项） */
export interface RemoteHostDraft {
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: RemoteAuthMethod;
  savePassword: boolean;
  password?: string;
}

/** 供应商切换后的「生效方式」报告 */
export interface EffectReport {
  target: string;
  providerName: string;
  conflictsCleaned: number;
  notes: string[];
}

/** 远端 shell 配置中的冲突环境变量 */
export interface RemoteEnvConflict {
  varName: string;
  varValue: string;
  sourceType: string;
  sourcePath: string;
}

/** 远端会话文件信息 */
export interface RemoteSessionInfo {
  path: string;
  name: string;
  size: number;
  modified: number | null;
}
