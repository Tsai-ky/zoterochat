/**
 * 对话文件的落盘位置。
 *
 * 目标：优先放在文献附件的 storage 目录（随 PDF 一起可移植），
 * 找不到可写目录时退回 Zotero 数据目录下的插件目录。
 * 纯选择逻辑（chooseConversationPath）不引用 Zotero，便于单测。
 */

import { logError } from "../utils/log";
import type { PaperRef } from "./types";

export const FALLBACK_DIRECTORY_NAME = "zoterochat";

export function conversationFileName(itemKey: string): string {
  return `zoterochat-${itemKey}.json`;
}

export interface CandidateDirectory {
  path: string;
  /** 目录是否已经存在；不替 Zotero 预创建缺失的 storage 目录。 */
  exists: boolean;
}

export interface ChooseConversationPathInput {
  itemKey: string;
  directories: CandidateDirectory[];
  fallbackDirectory: string;
  /** 回退目录里带 libraryID 的文件名，避免不同 library 的相同 itemKey 冲突。 */
  fallbackFileName?: string;
  fileExists: (path: string) => boolean;
}

export interface ChosenConversationPath {
  path: string;
  existing: boolean;
  /** attachment = 文献目录；fallback = 插件数据目录（需提示用户）。 */
  source: "attachment" | "fallback";
}

/**
 * 已有文件优先（即使它在后面的候选目录里），否则用第一个已存在的目录，
 * 都不存在时用插件回退目录。
 */
export function chooseConversationPath({
  itemKey,
  directories,
  fallbackDirectory,
  fallbackFileName,
  fileExists,
}: ChooseConversationPathInput): ChosenConversationPath {
  const fileName = conversationFileName(itemKey);

  for (const directory of directories) {
    const candidate = joinPath(directory.path, fileName);
    if (fileExists(candidate)) {
      return { path: candidate, existing: true, source: "attachment" };
    }
  }

  // 早先写入回退目录的文件要继续使用，避免附件后来下载完成时数据被拆成两份。
  const fallbackPath = joinPath(
    fallbackDirectory,
    fallbackFileName ?? conversationFileName(itemKey),
  );
  if (fileExists(fallbackPath)) {
    return { path: fallbackPath, existing: true, source: "fallback" };
  }

  const available = directories.find((directory) => directory.exists);
  if (available) {
    return {
      path: joinPath(available.path, fileName),
      existing: false,
      source: "attachment",
    };
  }

  return { path: fallbackPath, existing: false, source: "fallback" };
}

/** Windows 盘符路径（C:\ 或 C:/）与 UNC 路径（\\server\share）。 */
const WINDOWS_PATH_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/**
 * Windows 的 nsIFile.initWithPath 不接受混合分隔符
 * （如 C:\...\storage\KEY/name.json），因此 Windows 路径统一用反斜杠。
 * 纯逻辑不引用 Zotero，平台差异靠路径形态判断。
 */
function joinPath(directory: string, name: string): string {
  const base = directory.replace(/[\\/]+$/, "");
  if (WINDOWS_PATH_PATTERN.test(base)) {
    return `${base.replace(/\//g, "\\")}\\${name}`;
  }
  return `${base}/${name}`;
}

// ---------------------------------------------------------------- Zotero 适配

export interface ResolvedConversationPath extends ChosenConversationPath {
  /** 解析成功即为 true；实际写盘失败由存储层降级。 */
  persistent: boolean;
}

export function resolveConversationPath(
  paper: PaperRef,
): ResolvedConversationPath {
  const directories = collectCandidateDirectories(paper);
  const chosen = chooseConversationPath({
    itemKey: paper.itemKey,
    directories,
    fallbackDirectory: getFallbackDirectory(),
    fallbackFileName: conversationFileName(
      `${paper.libraryID}-${paper.itemKey}`,
    ),
    fileExists: pathExists,
  });
  return { ...chosen, persistent: true };
}

function collectCandidateDirectories(paper: PaperRef): CandidateDirectory[] {
  const directories: CandidateDirectory[] = [];
  const seen = new Set<string>();

  for (const attachmentID of orderedAttachmentIDs(paper)) {
    let directory: string;
    try {
      const attachment = Zotero.Items.get(attachmentID);
      if (!attachment) {
        continue;
      }
      directory = Zotero.Attachments.getStorageDirectory(attachment).path;
    } catch (e) {
      logError(e);
      continue;
    }
    if (seen.has(directory)) {
      continue;
    }
    seen.add(directory);
    directories.push({ path: directory, exists: pathExists(directory) });
  }

  return directories;
}

/** 当前阅读的 PDF 优先，其余 PDF 次之，最后是普通附件。 */
function orderedAttachmentIDs(paper: PaperRef): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const add = (id: number | undefined) => {
    if (id == null || seen.has(id)) {
      return;
    }
    seen.add(id);
    ids.push(id);
  };

  add(paper.attachmentID);
  for (const id of paper.attachmentIDs ?? []) {
    try {
      const item = Zotero.Items.get(id);
      if (item && item.isPDFAttachment()) {
        add(id);
      }
    } catch {
      // 单个附件读取失败不影响其它候选目录。
    }
  }
  for (const id of paper.attachmentIDs ?? []) {
    add(id);
  }
  return ids;
}

function getFallbackDirectory(): string {
  const base = String(Zotero.DataDirectory.dir ?? "").replace(/[\\/]+$/, "");
  return joinPath(base, FALLBACK_DIRECTORY_NAME);
}

function pathExists(path: string): boolean {
  try {
    return Zotero.File.pathToFile(path).exists();
  } catch (e) {
    logError(e);
    return false;
  }
}
