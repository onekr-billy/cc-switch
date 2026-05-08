import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Eye, Save, Languages } from "lucide-react";
import {
  useSaveSkillContent,
  useStreamPreviewTranslation,
  useSkillContent,
  type InstalledSkill
} from "@/hooks/useSkills";
import { toast } from "sonner";
import { useProvidersQuery } from "@/lib/query";

type TranslationAppType = "gemini" | "claude" | "codex";

const LANGUAGE_OPTIONS = [
  { value: "zh", labelKey: "languageOptionChinese", fallback: "中文" },
  { value: "ja", labelKey: "languageOptionJapanese", fallback: "日本語" },
];

interface SkillTranslationDialogProps {
  skill: InstalledSkill | null;
  open: boolean;
  onClose: () => void;
}

const MarkdownPreview: React.FC<{ content: string }> = ({ content }) => {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  const renderInline = (text: string) => {
    const nodes: React.ReactNode[] = [];
    const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null = null;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > lastIndex) {
        nodes.push(text.slice(lastIndex, match.index));
      }
      const token = match[0];
      if (token.startsWith("**") && token.endsWith("**")) {
        nodes.push(<strong key={`${match.index}-bold`}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("`") && token.endsWith("`")) {
        nodes.push(
          <code key={`${match.index}-code`} className="rounded bg-muted px-1 py-0.5 text-[0.85em]">
            {token.slice(1, -1)}
          </code>,
        );
      } else if (token.startsWith("[")) {
        const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          nodes.push(
            <a
              key={`${match.index}-link`}
              href={linkMatch[2]}
              target="_blank"
              rel="noreferrer"
              className="text-primary underline underline-offset-2"
            >
              {linkMatch[1]}
            </a>,
          );
        } else {
          nodes.push(token);
        }
      } else {
        nodes.push(token);
      }
      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < text.length) {
      nodes.push(text.slice(lastIndex));
    }

    return nodes;
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    if (trimmed.startsWith("```")) {
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      elements.push(
        <pre key={`code-${i}`} className="overflow-x-auto rounded-md border bg-muted/40 p-3">
          {language ? <div className="mb-1 text-xs text-muted-foreground">{language}</div> : null}
          <code className="font-mono text-sm">{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    if (/^#{1,6}\s+/.test(trimmed)) {
      const level = trimmed.match(/^#+/)?.[0].length ?? 1;
      const text = trimmed.replace(/^#{1,6}\s+/, "");
      const HeadingTag = `h${Math.min(level, 6)}` as keyof JSX.IntrinsicElements;
      const headingClass =
        level === 1
          ? "text-2xl font-bold"
          : level === 2
            ? "text-xl font-semibold"
            : "text-base font-semibold";
      elements.push(
        <HeadingTag key={`h-${i}`} className={headingClass}>
          {renderInline(text)}
        </HeadingTag>,
      );
      i += 1;
      continue;
    }

    if (trimmed === "---" || trimmed === "***") {
      elements.push(<hr key={`hr-${i}`} className="border-border" />);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const listItems: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        listItems.push(lines[i].trim().replace(/^[-*]\s+/, ""));
        i += 1;
      }
      elements.push(
        <ul key={`ul-${i}`} className="list-disc space-y-1 pl-5">
          {listItems.map((item, idx) => (
            <li key={`li-${idx}`}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    if (/^\d+\.\s+/.test(trimmed)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        listItems.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      elements.push(
        <ol key={`ol-${i}`} className="list-decimal space-y-1 pl-5">
          {listItems.map((item, idx) => (
            <li key={`li-${idx}`}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      elements.push(
        <blockquote
          key={`quote-${i}`}
          className="border-l-4 border-border pl-3 text-muted-foreground"
        >
          {quoteLines.join("\n")}
        </blockquote>,
      );
      continue;
    }

    const paragraph: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s+|```|[-*]\s+|\d+\.\s+|>\s?|---|\*\*\*)/.test(lines[i].trim())) {
      paragraph.push(lines[i]);
      i += 1;
    }
    elements.push(
      <p key={`p-${i}`} className="leading-7">
        {renderInline(paragraph.join(" "))}
      </p>,
    );
  }

  return <div className="space-y-3 text-sm text-foreground">{elements}</div>;
};

export const SkillTranslationDialog: React.FC<SkillTranslationDialogProps> = ({
  skill,
  open,
  onClose,
}) => {
  const { t, i18n } = useTranslation();
  const initialLang = i18n.language === "zh" ? "zh" : "en";
  const [targetLang, setTargetLang] = useState(initialLang);
  const [selectedProviderKey, setSelectedProviderKey] = useState<string>("");
  const [activeTab, setActiveTab] = useState("preview");
  const [leftPaneRatio, setLeftPaneRatio] = useState(50);
  const [isDraggingSplitter, setIsDraggingSplitter] = useState(false);
  const [leftActiveTab, setLeftActiveTab] = useState("original"); // 左侧面板标签页：original/translation
  const [originalContent, setOriginalContent] = useState(""); // 存储可编辑的原文内容
  const [translatedContent, setTranslatedContent] = useState(""); // 存储可编辑的译文内容
  const { data: content, isLoading: isLoadingContent } = useSkillContent(
    skill?.id || null,
    targetLang,
  );
  const streamMutation = useStreamPreviewTranslation();
  const saveMutation = useSaveSkillContent();
  const [translatedText, setTranslatedText] = useState("");
  const translatedTextRef = useRef(""); // 使用 ref 来存储最新的翻译内容
  const [isStreaming, setIsStreaming] = useState(false);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [cleanupStream, setCleanupStream] = useState<(() => void) | null>(null);
  const leftOriginalScrollRef = useRef<HTMLDivElement | null>(null);
  const leftTranslationScrollRef = useRef<HTMLDivElement | null>(null);
  const rightPreviewScrollRef = useRef<HTMLDivElement | null>(null);
  const splitContainerRef = useRef<HTMLDivElement | null>(null);
  const { data: claudeProvidersData } = useProvidersQuery("claude");
  const { data: codexProvidersData } = useProvidersQuery("codex");
  const { data: geminiProvidersData } = useProvidersQuery("gemini");

  const providerOptions = useMemo(() => {
    const options: Array<{
      key: string;
      providerId: string;
      appType: TranslationAppType;
      label: string;
    }> = [];
    const appendProviders = (
      data: typeof claudeProvidersData | undefined,
      appType: TranslationAppType,
      appLabel: string,
    ) => {
      if (!data) return;
      for (const provider of Object.values(data.providers)) {
        const key = `${appType}:${provider.id}`;
        options.push({
          key,
          providerId: provider.id,
          appType,
          label: `${provider.name} (${appLabel})`,
        });
      }
    };
    appendProviders(claudeProvidersData, "claude", "Claude");
    appendProviders(codexProvidersData, "codex", "Codex");
    appendProviders(geminiProvidersData, "gemini", "Gemini");
    return options;
  }, [claudeProvidersData, codexProvidersData, geminiProvidersData]);

  const selectedProviderMeta = useMemo(
    () => providerOptions.find((item) => item.key === selectedProviderKey) ?? null,
    [providerOptions, selectedProviderKey],
  );

  useEffect(() => {
    if (isStreaming) return;
    if (content?.translated) {
      setTranslatedText(content.translated);
      setTranslatedContent(content.translated); // 同步到可编辑状态
    } else {
      setTranslatedText("");
      setTranslatedContent("");
    }
    // 同步原文内容到可编辑状态
    if (content?.original) {
      setOriginalContent(String(content.original));
    }
  }, [content, skill]);

  useEffect(() => {
    if (!open) {
      setTargetLang(initialLang);
      setSelectedProviderKey("");
      setActiveTab("preview");
      setIsStreaming(false);
      setActiveRequestId(null);
      cleanupStream?.();
      setCleanupStream(null);
      setLeftPaneRatio(50);
    }
  }, [cleanupStream, initialLang, open]);

  // 当对话框打开且内容加载完成时，加载已翻译的内容
  useEffect(() => {
    if (open && content && !isStreaming) {
      // 如果有翻译内容，直接使用
      if (content.translated) {
        setTranslatedText(content.translated);
        setTranslatedContent(content.translated);
      } else {
        // 如果没有翻译内容，尝试查找已存在的翻译文件
        // 这里我们强制设置为空，但实际应该检查是否存在翻译文件
        setTranslatedText("");
        setTranslatedContent("");
      }
      // 同步原文内容
      if (content.original) {
        setOriginalContent(String(content.original));
      }
    }
  }, [open, content, skill, isStreaming]);

  useEffect(() => {
    if (!open || providerOptions.length === 0 || selectedProviderKey) return;
    const currentClaude = claudeProvidersData?.currentProviderId
      ? `claude:${claudeProvidersData.currentProviderId}`
      : "";
    const currentCodex = codexProvidersData?.currentProviderId
      ? `codex:${codexProvidersData.currentProviderId}`
      : "";
    const currentGemini = geminiProvidersData?.currentProviderId
      ? `gemini:${geminiProvidersData.currentProviderId}`
      : "";
    const preferred =
      [currentClaude, currentCodex, currentGemini].find((key) =>
        providerOptions.some((option) => option.key === key),
      ) ?? providerOptions[0].key;
    setSelectedProviderKey(preferred);
  }, [
    claudeProvidersData?.currentProviderId,
    codexProvidersData?.currentProviderId,
    geminiProvidersData?.currentProviderId,
    open,
    providerOptions,
    selectedProviderKey,
  ]);

  useEffect(() => {
    if (!isDraggingSplitter) return;
    const handleMove = (event: MouseEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = ((event.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(30, Math.min(70, ratio));
      setLeftPaneRatio(clamped);
    };
    const handleUp = () => setIsDraggingSplitter(false);
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [isDraggingSplitter]);

  // 同步滚动：左侧原文 ↔ 右侧原文预览
  useEffect(() => {
    if (leftActiveTab !== "original") return;
    
    let isSyncing = false;
    let leftEl: HTMLTextAreaElement | null = null;
    let rightEl: HTMLDivElement | null = null;
    
    const syncLeftToRight = () => {
      if (isSyncing || !leftEl || !rightEl) return;
      isSyncing = true;
      const leftMax = leftEl.scrollHeight - leftEl.clientHeight;
      const rightMax = rightEl.scrollHeight - rightEl.clientHeight;
      if (leftMax > 0 && rightMax > 0) {
        const percentage = leftEl.scrollTop / leftMax;
        rightEl.scrollTop = percentage * rightMax;
      }
      setTimeout(() => { isSyncing = false; }, 10);
    };

    const syncRightToLeft = () => {
      if (isSyncing || !leftEl || !rightEl) return;
      isSyncing = true;
      const leftMax = leftEl.scrollHeight - leftEl.clientHeight;
      const rightMax = rightEl.scrollHeight - rightEl.clientHeight;
      if (leftMax > 0 && rightMax > 0) {
        const percentage = rightEl.scrollTop / rightMax;
        leftEl.scrollTop = percentage * leftMax;
      }
      setTimeout(() => { isSyncing = false; }, 10);
    };

    // 使用 setTimeout 确保 DOM 已经渲染
    const timer = setTimeout(() => {
      leftEl = leftOriginalScrollRef.current as HTMLTextAreaElement | null;
      rightEl = rightPreviewScrollRef.current;
      if (!leftEl || !rightEl) return;

      leftEl.addEventListener("scroll", syncLeftToRight, { passive: true });
      rightEl.addEventListener("scroll", syncRightToLeft, { passive: true });
    }, 50);
    
    return () => {
      clearTimeout(timer);
      if (leftEl && rightEl) {
        leftEl.removeEventListener("scroll", syncLeftToRight);
        rightEl.removeEventListener("scroll", syncRightToLeft);
      }
    };
  }, [leftActiveTab, originalContent]);

  // 同步滚动：左侧译文 ↔ 右侧译文预览
  useEffect(() => {
    if (leftActiveTab !== "translation") return;
    
    let isSyncing = false;
    let leftEl: HTMLTextAreaElement | null = null;
    let rightEl: HTMLDivElement | null = null;
    
    const syncLeftToRight = () => {
      if (isSyncing || !leftEl || !rightEl) return;
      isSyncing = true;
      const leftMax = leftEl.scrollHeight - leftEl.clientHeight;
      const rightMax = rightEl.scrollHeight - rightEl.clientHeight;
      if (leftMax > 0 && rightMax > 0) {
        const percentage = leftEl.scrollTop / leftMax;
        rightEl.scrollTop = percentage * rightMax;
      }
      setTimeout(() => { isSyncing = false; }, 10);
    };

    const syncRightToLeft = () => {
      if (isSyncing || !leftEl || !rightEl) return;
      isSyncing = true;
      const leftMax = leftEl.scrollHeight - leftEl.clientHeight;
      const rightMax = rightEl.scrollHeight - rightEl.clientHeight;
      if (leftMax > 0 && rightMax > 0) {
        const percentage = rightEl.scrollTop / rightMax;
        leftEl.scrollTop = percentage * leftMax;
      }
      setTimeout(() => { isSyncing = false; }, 10);
    };

    // 使用 setTimeout 确保 DOM 已经渲染
    const timer = setTimeout(() => {
      leftEl = leftTranslationScrollRef.current as HTMLTextAreaElement | null;
      rightEl = rightPreviewScrollRef.current;
      if (!leftEl || !rightEl) return;

      leftEl.addEventListener("scroll", syncLeftToRight, { passive: true });
      rightEl.addEventListener("scroll", syncRightToLeft, { passive: true });
    }, 50);
    
    return () => {
      clearTimeout(timer);
      if (leftEl && rightEl) {
        leftEl.removeEventListener("scroll", syncLeftToRight);
        rightEl.removeEventListener("scroll", syncRightToLeft);
      }
    };
  }, [leftActiveTab, translatedContent]);

  const handleTranslate = async () => {
    if (!content?.original) return;
    if (isStreaming) return;
    if (!selectedProviderMeta) {
      toast.error(t("skills.translateFailed"), { description: t("skills.providerRequired") });
      return;
    }

    cleanupStream?.();
    setCleanupStream(null);
    const requestId = `${skill?.id ?? "skill"}-${Date.now()}`;
    setActiveRequestId(requestId);
    setIsStreaming(true);
    setTranslatedText("");

    try {
      const disposer = await streamMutation.mutateAsync({
        requestId,
        text: content.original as string,
        targetLang,
        appType: selectedProviderMeta.appType,
        providerId: selectedProviderMeta.providerId,
        onChunk: (delta) => {
          setTranslatedText((prev) => {
            const newText = prev + delta;
            translatedTextRef.current = newText; // 同步更新 ref
            return newText;
          });
        },
        onDone: async () => {
          setIsStreaming(false);
          setActiveRequestId(null);

          // 翻译完成后自动保存
          if (skill && translatedTextRef.current) {
            setTranslatedContent(translatedTextRef.current); // 同步到可编辑状态
            try {
              await saveMutation.mutateAsync({
                id: skill.id,
                lang: targetLang,
                content: translatedTextRef.current,
              });
              toast.success(t("skills.translateSuccess", { name: skill.name }));
            } catch (error) {
              toast.error(t("skills.saveFailed"), { description: String(error) });
            }
          }
        },
        onError: (errorMessage) => {
          setIsStreaming(false);
          setActiveRequestId(null);
          toast.error(t("skills.translateFailed"), { description: errorMessage });
        },
      });
      setCleanupStream(() => disposer);
    } catch (error) {
      setIsStreaming(false);
      setActiveRequestId(null);
      toast.error(t("skills.translateFailed"), { description: String(error) });
    }
  };

  const handleCancelStream = () => {
    cleanupStream?.();
    setCleanupStream(null);
    setIsStreaming(false);
    setActiveRequestId(null);
  };

  const handleSave = async () => {
    if (!skill || !translatedText) return;
    try {
      await saveMutation.mutateAsync({
        id: skill.id,
        lang: targetLang,
        content: translatedText,
      });
      toast.success(t("skills.translateSuccess", { name: skill.name }));
      onClose();
    } catch (error) {
      toast.error(t("skills.saveFailed"), { description: String(error) });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(val) => !val && onClose()}>
      <DialogContent
        overlayClassName="top-8"
        className="w-[90vw] mt-10 max-w-none h-[calc(100vh-96px)] flex flex-col overflow-hidden"
      >
        <div
          data-tauri-drag-region
          className="h-5 flex-shrink-0 cursor-move"
          title={t("common.dragWindow", "拖动窗口")}
        />
        <DialogHeader className="pb-2 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Eye className="w-5 h-5 text-primary" />
            {t("skills.view")}: {skill?.name}
          </DialogTitle>
          <DialogDescription>
            {t("skills.translateDescription", "对比原始 SKILL.md 和翻译内容，确认后保存。")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 p-3 pb-0">
          <Tabs value={leftActiveTab} onValueChange={setLeftActiveTab}>
            <TabsList className="w-fit">
              <TabsTrigger className="p-1" value="original">原文</TabsTrigger>
              <TabsTrigger className="p-1" value="translation">译文</TabsTrigger>
            </TabsList>
          </Tabs>
          {leftActiveTab === "translation" && (
            <>
              <Select value={targetLang} onValueChange={setTargetLang}>
                <SelectTrigger className="w-[120px]">
                  <SelectValue placeholder={t("skills.targetLanguage")} />
                </SelectTrigger>
                <SelectContent>
                  {LANGUAGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(`settings.${option.labelKey}`, option.fallback)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={selectedProviderKey} onValueChange={setSelectedProviderKey}>
                <SelectTrigger className="w-[260px]">
                  <SelectValue placeholder={t("skills.provider")} />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((option) => (
                    <SelectItem key={option.key} value={option.key}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-2">
                {isStreaming ? (
                  <Button variant="outline" onClick={handleCancelStream} className="gap-2">
                    {t("skills.cancelTranslation")}
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  onClick={handleTranslate}
                  disabled={
                    !content?.original ||
                    isStreaming ||
                    !selectedProviderMeta
                  }
                  className="gap-2 whitespace-nowrap"
                >
                  {isStreaming ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Languages className="w-4 h-4" />
                  )}
                  {isStreaming ? t("skills.streamTranslating") : t("skills.startTranslation")}
                </Button>
              </div>
            </>
          )}
        </div>

        <div ref={splitContainerRef} className="flex-1 min-h-0 p-3 flex gap-2">
          <div
            className="flex flex-col gap-2 min-h-0 rounded-lg border bg-muted/20 p-3"
            style={{ width: `calc(${leftPaneRatio}% - 4px)` }}
          >
            <Tabs value={leftActiveTab} onValueChange={setLeftActiveTab} className="flex flex-col min-h-0 flex-1">
            <div className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm rounded-md">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 px-1 pb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
                Markdown
              </div>
            </div>
              <TabsContent
                value="original"
                className="mt-1 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden data-[state=active]:flex"
              >
                <Textarea
                  ref={leftOriginalScrollRef as any}
                  className="flex-1 overflow-auto border rounded-md bg-muted/10 p-3 font-mono text-sm whitespace-pre-wrap resize-none"
                  value={originalContent}
                  onChange={(e) => setOriginalContent(e.target.value)}
                />
              </TabsContent>
              <TabsContent
                value="translation"
                className="mt-1 min-h-0 flex-1 overflow-hidden data-[state=inactive]:hidden data-[state=active]:flex"
              >
                <Textarea
                  ref={leftTranslationScrollRef as any}
                  className="flex-1 overflow-auto border rounded-md bg-muted/10 p-3 font-mono text-sm whitespace-pre-wrap resize-none"
                  value={translatedContent}
                  onChange={(e) => setTranslatedContent(e.target.value)}
                />
              </TabsContent>
            </Tabs>
          </div>
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={() => setIsDraggingSplitter(true)}
            className="w-2 cursor-col-resize flex items-center justify-center group"
            title={t("skills.dragToResize")}
          >
            <div className="h-16 w-1 rounded bg-border group-hover:bg-primary/60 transition-colors" />
          </div>

          <div
            className="flex flex-col gap-2 min-h-0 rounded-lg border bg-muted/20 p-3"
            style={{ width: `calc(${100 - leftPaneRatio}% - 4px)` }}
          >
            <div className="sticky top-0 z-10 bg-background/90 backdrop-blur-sm rounded-md space-y-2">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5 px-1 pb-2">
                <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />
                预览
              </div>
            </div>
            <div
              ref={rightPreviewScrollRef}
              className="flex-1 overflow-auto rounded-md border bg-background p-3"
            >
              {leftActiveTab === "original" ? (
                <MarkdownPreview content={originalContent || ""} />
              ) : (
                <MarkdownPreview content={translatedContent || "暂无译文"} />
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 pt-3 border-t">
          {leftActiveTab === "original" && (
            <Button
              variant="outline"
              onClick={async () => {
                if (!skill || !originalContent) return;
                try {
                  await saveMutation.mutateAsync({
                    id: skill.id,
                    lang: "original",
                    content: originalContent,
                  });
                  toast.success(t("skills.saveSuccess", { name: skill.name }));
                } catch (error) {
                  toast.error(t("skills.saveFailed"), { description: String(error) });
                }
              }}
              disabled={saveMutation.isPending}
              className="gap-2"
            >
              <Save className="w-4 h-4" />
              {t("common.save", "保存")}
            </Button>
          )}
          {leftActiveTab === "translation" && (
            <Button
              variant="outline"
              onClick={async () => {
                if (!skill || !translatedContent) return;
                try {
                  await saveMutation.mutateAsync({
                    id: skill.id,
                    lang: targetLang,
                    content: translatedContent,
                  });
                  toast.success(t("skills.saveSuccess", { name: skill.name }));
                } catch (error) {
                  toast.error(t("skills.saveFailed"), { description: String(error) });
                }
              }}
              disabled={saveMutation.isPending}
              className="gap-2"
            >
              <Save className="w-4 h-4" />
              {t("common.save", "保存")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose} className="px-6">
            {t("common.close", "关闭")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
