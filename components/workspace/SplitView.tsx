"use client";

import { useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/lib/cn";

type ViewMode = "code" | "split" | "preview";

interface Props {
  code: React.ReactNode;
  preview: React.ReactNode;
}

export function SplitView({ code, preview }: Props) {
  const [mode, setMode] = useState<ViewMode>("split");

  return (
    <div className="flex h-full flex-col">
      <div className="huddle-panel-header gap-0.5 border-b border-border px-2">
        {(["code", "split", "preview"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={cn(
              "rounded px-2 py-0.5 text-xs capitalize",
              mode === m ? "bg-bg-raised text-fg" : "text-fg-subtle hover:text-fg"
            )}
          >
            {m}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {mode === "code" && code}
        {mode === "preview" && preview}
        {mode === "split" && (
          <Group orientation="horizontal" className="h-full">
            <Panel defaultSize={50} minSize={20} className="h-full min-w-0 border-r border-border">
              {code}
            </Panel>
            <Separator className="w-1 shrink-0 cursor-col-resize bg-border transition-colors hover:bg-accent" />
            <Panel defaultSize={50} minSize={20} className="h-full min-w-0">
              {preview}
            </Panel>
          </Group>
        )}
      </div>
    </div>
  );
}
