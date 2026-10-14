import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  ContentRef,
  ImageRef,
  SessionMessage,
  SessionMeta,
  TranscriptChunk,
} from "@/types";

export interface DeleteSessionOptions {
  providerId: string;
  sessionId: string;
  sourcePath: string;
  /** 远端目标（本补丁层）：非空时删除走远端命令 */
  remoteTargetId?: string;
  remoteContainerId?: string;
}

export interface DeleteSessionResult extends DeleteSessionOptions {
  success: boolean;
  error?: string;
}

/** get_session_block_content 的返回：按字符分页取工具输出 / 参数 / 思考 / diff 全文 */
export interface BlockContent {
  text: string;
  /** 全文字符数 */
  totalLen: number;
  /** 本页之后还有内容 */
  truncated: boolean;
  /** 下一页的起始字符偏移 */
  nextOffset?: number;
}

export interface BlockContentPage {
  offset?: number;
  limit?: number;
}

export const sessionsApi = {
  async list(): Promise<SessionMeta[]> {
    return await invoke("list_sessions");
  },

  async getMessages(
    providerId: string,
    sourcePath: string,
  ): Promise<SessionMessage[]> {
    return await invoke("get_session_messages", { providerId, sourcePath });
  },

  /**
   * 分块读取会话（stream_session_messages）：后端先推 Header，再按批推 Messages，
   * 最后 Done；失败时先推 Error 再以同一文案 reject。
   */
  async streamMessages(
    providerId: string,
    sourcePath: string,
    onChunk: (chunk: TranscriptChunk) => void,
  ): Promise<void> {
    const channel = new Channel<TranscriptChunk>();
    channel.onmessage = onChunk;
    await invoke("stream_session_messages", {
      providerId,
      sourcePath,
      onChunk: channel,
    });
  },

  /** 按 ContentRef 取全文（引用原样回传，前端不解析）；按字符分页，每页最多 512K 字符 */
  async getBlockContent(
    providerId: string,
    sourcePath: string,
    contentRef: ContentRef,
    page: BlockContentPage = {},
  ): Promise<BlockContent> {
    return await invoke("get_session_block_content", {
      providerId,
      sourcePath,
      contentRef,
      offset: page.offset,
      limit: page.limit,
    });
  },

  /** 取图片原始字节（后端返回 tauri::ipc::Response），调用方按 mediaType 转 Blob；SVG 会被后端拒绝 */
  async getImage(
    providerId: string,
    sourcePath: string,
    image: ImageRef,
  ): Promise<ArrayBuffer> {
    return await invoke("get_session_image", {
      providerId,
      sourcePath,
      image,
    });
  },

  /** 在 Finder / 文件管理器中显示本地路径（绝对路径或 file://，决策 D3） */
  async revealPath(path: string): Promise<boolean> {
    return await invoke("reveal_session_path", { path });
  },

  /** 弹出保存对话框把会话存成 Markdown 文件；取消时返回 null，成功返回保存路径 */
  async exportMarkdown(
    defaultName: string,
    content: string,
  ): Promise<string | null> {
    return await invoke("export_session_markdown", { defaultName, content });
  },

  async delete(options: DeleteSessionOptions): Promise<boolean> {
    const { providerId, sessionId, sourcePath, remoteTargetId, remoteContainerId } = options;
    if (remoteTargetId) {
      const { deleteRemoteSession } = await import("./remote");
      return await deleteRemoteSession(
        remoteTargetId,
        sourcePath,
        sessionId,
        remoteContainerId,
        providerId,
      );
    }
    return await invoke("delete_session", {
      providerId,
      sessionId,
      sourcePath,
    });
  },

  async deleteMany(
    items: DeleteSessionOptions[],
  ): Promise<DeleteSessionResult[]> {
    // 远端：逐条走远端命令（后端无批量远端删除命令），聚合同款结果
    const remoteItems = items.filter((item) => item.remoteTargetId);
    if (remoteItems.length > 0) {
      const { deleteRemoteSession } = await import("./remote");
      const outcomes: DeleteSessionResult[] = [];
      for (const item of items) {
        if (!item.remoteTargetId) {
          outcomes.push({
            ...item,
            success: false,
            error: "远端目标下不能删除本机会话",
          });
          continue;
        }
        try {
          await deleteRemoteSession(
            item.remoteTargetId,
            item.sourcePath,
            item.sessionId,
            item.remoteContainerId,
            item.providerId,
          );
          outcomes.push({ ...item, success: true });
        } catch (error) {
          outcomes.push({
            ...item,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return outcomes;
    }
    return await invoke("delete_sessions", { items });
  },

  async launchTerminal(options: {
    command: string;
    cwd?: string | null;
    customConfig?: string | null;
  }): Promise<boolean> {
    const { command, cwd, customConfig } = options;
    return await invoke("launch_session_terminal", {
      command,
      cwd,
      customConfig,
    });
  },
};
