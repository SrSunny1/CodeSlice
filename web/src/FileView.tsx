import { useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { readWorkspaceFile, workspaceAssetUrl } from "./api";
import { IconFileCode } from "./icons";
import { usePaneZoom } from "./paneZoom";

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/** 把相对路径按 posix 规则归一化（a/b/../c → a/c），用于解析 md 里的相对链接与图片。 */
function resolveRel(base: string, rel: string): string {
  const out: string[] = [];
  for (const p of (base ? base.split("/") : []).concat(rel.split("/"))) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

export default function FileView({
  root,
  filePath,
  onSlice,
  onOpenFile,
}: {
  root: string;
  filePath: string;
  /** 点击「切分阅读」：切回切分模式（有会话直接进 Reader，没有则读文件并切分） */
  onSlice: () => void;
  /** md 预览里相对链接的跳转（普通打开） */
  onOpenFile: (path: string) => void;
}) {
  const [data, setData] = useState<{ content: string; language: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [preview, setPreview] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  usePaneZoom(bodyRef, "zOverview");

  const isMd = /\.(md|markdown|mdx)$/i.test(filePath);
  const dir = dirOf(filePath);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    setPreview(true);
    readWorkspaceFile(root, filePath)
      .then((f) => {
        if (!cancelled) setData(f);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, filePath]);

  // md 预览：相对链接跳转到对应文件的预览，相对图片走 /api/workspace/asset
  const mdComponents = useMemo(
    () => ({
      a({ href, children }: { href?: string; children?: React.ReactNode }) {
        if (!href) return <a>{children}</a>;
        if (/^(https?:|mailto:)/i.test(href)) {
          return (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          );
        }
        if (href.startsWith("#")) return <a href={href}>{children}</a>;
        let rel = href.split("#")[0];
        try {
          rel = decodeURIComponent(rel);
        } catch {
          /* 保留原样 */
        }
        const resolved = resolveRel(dir, rel);
        return (
          <a
            href={href}
            title={resolved}
            onClick={(e) => {
              e.preventDefault();
              onOpenFile(resolved);
            }}
          >
            {children}
          </a>
        );
      },
      img({ src, alt }: { src?: string; alt?: string }) {
        if (!src) return <>{alt}</>;
        if (/^(https?:|data:|blob:)/i.test(src)) {
          return <img src={src} alt={alt ?? ""} loading="lazy" />;
        }
        const resolved = resolveRel(dir, src.split("#")[0]);
        return <img src={workspaceAssetUrl(root, resolved)} alt={alt ?? ""} loading="lazy" />;
      },
    }),
    [dir, root, onOpenFile]
  );

  const lines = useMemo(() => data?.content.split("\n") ?? [], [data]);

  return (
    <div className="fileview">
      <div className="fv-head">
        <span className="sb-item-icon file-icon">
          <IconFileCode size={14} />
        </span>
        <span className="fv-path" title={filePath}>
          {filePath}
        </span>
        {data && <span className="reader-chip">{data.language}</span>}
        <div className="fv-head-actions">
          {isMd && data && (
            <div className="fv-seg" role="group" aria-label="Markdown 显示方式">
              <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>
                预览
              </button>
              <button className={!preview ? "on" : ""} onClick={() => setPreview(false)}>
                源码
              </button>
            </div>
          )}
          <button
            className="primary fv-slice-btn"
            onClick={onSlice}
            title="让 AI 把该文件切分成若干段，逐段阅读与问答"
          >
            切分阅读
          </button>
        </div>
      </div>
      <div className="fv-body" ref={bodyRef}>
        {loading && (
          <div className="ws-loading-card">
            <div className="ws-loading-spinner" />
            <div className="ws-loading-text">正在读取 {filePath}…</div>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
        {data && isMd && preview && (
          <div className="fv-md summary-body">
            <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
              {data.content}
            </Markdown>
          </div>
        )}
        {data && !(isMd && preview) && (
          <div className="fv-code">
            {lines.map((l, i) => (
              <div className="fv-row" key={i}>
                <span className="fv-ln">{i + 1}</span>
                <span className="fv-tx">{l === "" ? " " : l}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
