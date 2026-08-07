import type { ReactNode } from "react";

/** ① ② ③ …⑩（超出 10 条回退为数字序号） */
const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩";

/**
 * 把切换/同步报告的 notes 渲染成 toast description：
 * - 单条 → 原样字符串（不啰嗦）；
 * - 多条 → ① ② ③… 序号的列表，一眼看清「写入了什么 / 何时生效」。
 */
export function notesList(notes: string[]): ReactNode {
  if (notes.length === 0) return undefined;
  if (notes.length === 1) return notes[0];
  return (
    <div className="space-y-0.5 text-left">
      {notes.map((n, i) => (
        <div key={i} className="flex gap-1.5">
          <span className="shrink-0">{CIRCLED[i] ?? `${i + 1}.`}</span>
          <span>{n}</span>
        </div>
      ))}
    </div>
  );
}
