import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Download, FileText, Folder, FolderPlus, RefreshCw, Save, Trash2 } from "lucide-react";
import type { ServerWebSocketMessage, SftpEntry } from "@edgesh/contracts";
import type { SessionChannel } from "./TerminalPane";
import type { MessageKey } from "../lib/i18n";

type Props = {
  channel: SessionChannel | null;
  message: ServerWebSocketMessage | null;
  t: (key: MessageKey) => string;
};

export function FileWorkspace({ channel, message, t }: Props) {
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [active, setActive] = useState<SftpEntry>();
  const [content, setContent] = useState("");
  const [loadedMeta, setLoadedMeta] = useState<{ size: number; modifiedAt: string }>();
  const [status, setStatus] = useState("");
  const pendingReadRequest = useRef<string>();
  const pendingWrite = useRef<{ requestId: string; bytes: Uint8Array }>();
  const listRequests = useRef(new Map<string, boolean>());
  const download = useRef<{
    requestId: string;
    transferId: string;
    bytes: Uint8Array;
    received: number;
  }>();

  const send = (payload: Record<string, unknown>) => channel?.send(payload) ?? null;
  const requestDirectory = (cursor?: string) => {
    if (!channel) return;
    const requestId = send({ type: "sftp-list", path, ...(cursor ? { cursor } : {}) });
    if (requestId) listRequests.current.set(requestId, cursor !== undefined);
  };
  const refresh = () => {
    if (!channel) return;
    setStatus(t("loading"));
    listRequests.current.clear();
    requestDirectory();
  };

  useEffect(() => { refresh(); }, [channel?.sessionId, path]);
  useEffect(() => {
    if (!message) return;
    if (message.type === "file-result") {
      if (message.operation === "list") {
        const append = message.requestId
          ? listRequests.current.get(message.requestId) ?? false
          : false;
        if (message.requestId) listRequests.current.delete(message.requestId);
        setEntries((current) => append ? [...current, ...message.entries] : message.entries);
        if (message.nextCursor) requestDirectory(message.nextCursor);
        else setStatus("");
      } else if (message.operation === "read") {
        setLoadedMeta({ size: message.size, modifiedAt: message.modifiedAt });
      } else {
        setStatus("");
        pendingWrite.current = undefined;
        refresh();
      }
      return;
    }

    if (message.type !== "transfer-ready") return;
    const readRequestId = pendingReadRequest.current;
    if (
      message.direction === "download" &&
      readRequestId !== undefined &&
      message.requestId === readRequestId
    ) {
      download.current = {
        requestId: readRequestId,
        transferId: message.transferId,
        bytes: new Uint8Array(message.totalBytes),
        received: 0,
      };
      if (message.totalBytes === 0) {
        setContent("");
        setStatus("");
      }
    }

    const write = pendingWrite.current;
    if (
      message.direction === "upload" &&
      write !== undefined &&
      message.requestId === write.requestId
    ) {
      const bytes = write.bytes;
      let sequence = 0;
      for (let offset = message.resumeOffset; offset < bytes.byteLength; offset += message.chunkSize) {
        const chunk = bytes.subarray(offset, Math.min(bytes.byteLength, offset + message.chunkSize));
        channel?.sendBinary("sftp-upload-chunk", chunk, {
          transferId: message.transferId,
          sequence: sequence++,
          offset,
        });
      }
    }
  }, [message]);

  useEffect(() => channel?.subscribeBinary(({ header, payload }) => {
    const transfer = download.current;
    if (
      !transfer ||
      header.kind !== "sftp-download-chunk" ||
      header.transferId !== transfer.transferId ||
      header.offset === undefined ||
      header.offset !== transfer.received ||
      header.offset + payload.byteLength > transfer.bytes.byteLength
    ) return;
    transfer.bytes.set(payload, header.offset);
    transfer.received += payload.byteLength;
    if (transfer.received === transfer.bytes.byteLength) {
      setContent(new TextDecoder("utf-8").decode(transfer.bytes));
      setStatus("");
      download.current = undefined;
      pendingReadRequest.current = undefined;
    }
  }), [channel]);

  const parent = useMemo(() => path === "." || path === "/" ? path : path.replace(/\/[^/]+\/?$/, "") || "/", [path]);
  function open(entry: SftpEntry) {
    if (entry.kind === "directory") {
      setPath(entry.path);
      setActive(undefined);
      setContent("");
    } else if (entry.kind === "file") {
      setActive(entry);
      setStatus(t("loading"));
      pendingReadRequest.current = send({
        type: "sftp-read",
        path: entry.path,
        maxBytes: 2 * 1024 * 1024,
      }) ?? undefined;
    }
  }
  function createFolder() {
    const name = window.prompt(t("newFolder"));
    if (!name || name.includes("/") || name.includes("\0")) return;
    send({ type: "sftp-mkdir", path: `${path.replace(/\/$/, "")}/${name}`, mode: 0o755 });
  }
  function deleteEntry(entry: SftpEntry) {
    if (!window.confirm(`${t("delete")}: ${entry.name}?`)) return;
    send({ type: "sftp-delete", path: entry.path, kind: entry.kind === "directory" ? "empty_directory" : "file" });
  }
  function save() {
    if (!active || !loadedMeta) return;
    const bytes = new TextEncoder().encode(content);
    const requestId = send({
      type: "sftp-write",
      path: active.path,
      size: bytes.byteLength,
      expectedSize: loadedMeta.size,
      expectedModifiedAt: loadedMeta.modifiedAt,
    });
    if (requestId) pendingWrite.current = { requestId, bytes };
    setStatus(t("loading"));
  }
  function downloadFile() {
    if (!active) return;
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = active.name;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="file-workspace">
      <div className="file-browser">
        <div className="file-toolbar">
          <span title={path}>{path}</span>
          <div>
            <button type="button" title={t("refresh")} disabled={!channel} onClick={refresh}><RefreshCw size={15} /></button>
            <button type="button" title={t("newFolder")} disabled={!channel} onClick={createFolder}><FolderPlus size={15} /></button>
          </div>
        </div>
        <div className="file-list">
          {path !== "." && path !== "/" ? <button className="file-row" type="button" onClick={() => setPath(parent)}><ArrowUp size={15} /><span>..</span><small /></button> : null}
          {entries.map((entry) => (
            <div className={`file-row${active?.path === entry.path ? " active" : ""}`} key={entry.path}>
              <button type="button" className="file-main" onClick={() => open(entry)}>
                {entry.kind === "directory" ? <Folder size={15} /> : <FileText size={15} />}
                <span>{entry.name}</span><small>{entry.kind === "file" ? `${entry.size} B` : ""}</small>
              </button>
              <button type="button" className="file-delete" title={t("delete")} onClick={() => deleteEntry(entry)}><Trash2 size={13} /></button>
            </div>
          ))}
          {channel && entries.length === 0 && !status ? <p className="empty-state">{t("emptyDirectory")}</p> : null}
        </div>
      </div>
      <div className="editor-pane">
        <div className="file-toolbar">
          <span>{active?.path ?? t("files")}</span>
          <div>
            <button type="button" title={t("download")} disabled={!active} onClick={downloadFile}><Download size={15} /></button>
            <button type="button" title={t("save")} disabled={!active} onClick={save}><Save size={15} /></button>
          </div>
        </div>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} disabled={!active} spellCheck={false} />
        <small className="editor-status">{status}</small>
      </div>
    </section>
  );
}
