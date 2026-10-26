"use client";
import { createContext, useContext, type ComponentType } from "react";

/**
 * What node views need from the editor that renders them. TipTap renders React node
 * views inside EditorContent's tree, so they can read this context. The Editor
 * component itself is passed along so a synced block can render a nested editor
 * without a circular import.
 */
export interface EditorContextValue {
  pageId: string;
  workspaceId: string;
  user: { name: string; color: string };
  readOnly: boolean;
  commentedBlocks: Set<string>;
  onComment: (blockId: string | null) => void;
  Editor: ComponentType<any>;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("EditorContext missing");
  return ctx;
}
