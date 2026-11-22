import { useState } from "react";
import { api } from "../../api";
import type { IssueFile } from "../../api/issues";
import { errorText } from "../../lib/errorText";
import { IssueIcon } from "./IssueIcon";

export function FileLinks({ files, token, menu = false }: { files: IssueFile[]; token: string; menu?: boolean }) {
  const [error, setError] = useState("");
  async function download(file: IssueFile) {
    try {
      setError("");
      const link = document.createElement("a");
      link.href = await api.issueAttachmentUrl(token, file.id);
      link.download = file.file_name;
      link.rel = "noopener";
      link.click();
    } catch (e) { setError(errorText(e)); }
  }
  return <>{files.length > 0 && <div className={menu ? "issue-file-menu" : "issue-file-list"}>{files.map(file =>
    <button className={menu ? "issue-menu-row" : "issue-tag"} aria-label={"下载 " + file.file_name} key={file.id} onClick={() => void download(file)}><IssueIcon name="attach" size={14} /><span>{file.file_name}</span>{menu && <IssueIcon name="download" size={14} />}</button>)}</div>}
    {error && <p role="alert" className="issue-error">{error}</p>}</>;
}
