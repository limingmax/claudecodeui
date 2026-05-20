import React from 'react';
import { BotIcon, ChevronRightIcon } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../../../shared/view/ui/Collapsible';

export interface ShellAutopilotToggles {
  execution: boolean;
  reviewFix: boolean;
  commit: boolean;
}

export interface ShellAutopilotLimits {
  idleMs: number;
  maxContinue: number;
  maxReviewFix: number;
}

export interface ShellAutopilotState {
  state: string;
  continueCount: number;
  reviewFixCount: number;
}

export interface ShellAutopilotPanelProps {
  toggles: ShellAutopilotToggles;
  limits: ShellAutopilotLimits;
  autopilotState: ShellAutopilotState;
  onTogglesChange: (next: ShellAutopilotToggles) => void;
  onLimitsChange: (next: ShellAutopilotLimits) => void;
  onAbort: () => void;
  isConnected: boolean;
}

const STATE_COLORS: Record<string, string> = {
  IDLE: 'text-muted-foreground',
  EXECUTING: 'text-blue-500',
  WAITING_PROBE_RESPONSE: 'text-yellow-500',
  REVIEWING: 'text-purple-500',
  WAITING_REVIEW_RESPONSE: 'text-purple-400',
  FIXING: 'text-orange-500',
  WAITING_FIX_RESPONSE: 'text-orange-400',
  COMMITTING: 'text-cyan-500',
  DONE: 'text-emerald-500',
  FAILED: 'text-destructive',
  CANCELLED: 'text-muted-foreground',
};

const STATE_DOT_COLORS: Record<string, string> = {
  IDLE: 'bg-muted-foreground/40',
  EXECUTING: 'bg-blue-500',
  WAITING_PROBE_RESPONSE: 'bg-yellow-500',
  REVIEWING: 'bg-purple-500',
  WAITING_REVIEW_RESPONSE: 'bg-purple-400',
  FIXING: 'bg-orange-500',
  WAITING_FIX_RESPONSE: 'bg-orange-400',
  COMMITTING: 'bg-cyan-500',
  DONE: 'bg-emerald-500',
  FAILED: 'bg-destructive',
  CANCELLED: 'bg-muted-foreground/40',
};

interface SwitchProps {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  colorOn: string;
  colorOnBorder: string;
}

function Switch({ id, checked, disabled, onChange, colorOn, colorOnBorder }: SwitchProps) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50',
        checked
          ? `${colorOn} ${colorOnBorder}`
          : 'bg-gray-300 border-gray-400 dark:bg-gray-600 dark:border-gray-500',
      )}
    >
      <span
        className={cn(
          'pointer-events-none block h-5 w-5 rounded-full bg-white shadow-md ring-0 transition-transform',
          checked ? 'translate-x-5' : 'translate-x-0',
        )}
      />
    </button>
  );
}

export default function ShellAutopilotPanel({
  toggles,
  limits,
  autopilotState,
  onTogglesChange,
  onLimitsChange,
  onAbort,
  isConnected,
}: ShellAutopilotPanelProps) {
  const isActive = autopilotState.state !== 'IDLE' && autopilotState.state !== 'DONE' && autopilotState.state !== 'CANCELLED';
  const dotColor = STATE_DOT_COLORS[autopilotState.state] ?? STATE_DOT_COLORS.IDLE;
  const stateColor = STATE_COLORS[autopilotState.state] ?? STATE_COLORS.IDLE;
  // Configuration controls (toggles + limit inputs) are independent of terminal
  // connection — only locked while autopilot is actively running. The abort
  // button still uses isConnected (it only renders inside an isActive guard
  // anyway, where an attached connection is implied).
  const configLocked = isActive;
  // Stages section is only configurable when the master switch is on.
  const stagesDisabled = configLocked || !toggles.execution;

  return (
    <Collapsible defaultOpen={false} className="rounded-none border-t border-border/60 bg-muted/20">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-muted/40 transition-colors">
        <div className="flex items-center gap-2">
          <BotIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">自动模式配置</span>
          {toggles.execution && !isActive && (
            <span className="text-[10px] text-emerald-500 font-medium">已启用</span>
          )}
          {isActive && (
            <span className={cn('flex items-center gap-1 text-[10px] font-medium', stateColor)}>
              <span className={cn('h-1.5 w-1.5 rounded-full animate-pulse', dotColor)} />
              {autopilotState.state}
            </span>
          )}
        </div>
        <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-90" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1 space-y-3">
          {isActive && (
            <div className="flex items-center justify-between rounded-md border border-border/50 bg-background/60 px-2.5 py-1.5">
              <div className="flex gap-3 text-[10px] text-muted-foreground tabular-nums">
                <span>询问 {autopilotState.continueCount}/{limits.maxContinue}</span>
                {toggles.reviewFix && (
                  <span>评审修复 {autopilotState.reviewFixCount}/{limits.maxReviewFix}</span>
                )}
              </div>
              <button
                type="button"
                onClick={onAbort}
                className="rounded bg-destructive/80 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-destructive transition-colors"
              >
                中止
              </button>
            </div>
          )}

          {isActive && (
            <p className="text-[10px] text-muted-foreground/60 leading-tight">
              已启动后改环节开关不生效，需中止后重连
            </p>
          )}

          {/* Master switch */}
          <div className="flex items-center justify-between gap-3 rounded-md border border-border/50 bg-background/40 px-2.5 py-2">
            <div className="flex flex-col gap-0.5">
              <label
                htmlFor="shell-autopilot-master"
                className={cn('text-xs font-semibold leading-none', configLocked ? 'text-muted-foreground/50' : 'text-foreground')}
              >
                自动模式
              </label>
              <span className="text-[10px] text-muted-foreground leading-tight">
                终端空闲达到设定秒数后自动询问任务是否完成；配了环节则自动推进，未配则任务完成即停止
              </span>
            </div>
            <Switch
              id="shell-autopilot-master"
              checked={toggles.execution}
              disabled={configLocked}
              onChange={() => onTogglesChange({ ...toggles, execution: !toggles.execution })}
              colorOn="bg-blue-600"
              colorOnBorder="border-blue-700"
            />
          </div>

          {/* When master is ON, show interval + max-question and the stages section */}
          {toggles.execution && (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">终端空闲多久后询问（秒）</span>
                <input
                  type="number"
                  min={3}
                  max={120}
                  value={Math.round(limits.idleMs / 1000)}
                  disabled={configLocked}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    if (!isNaN(parsed) && parsed >= 3 && parsed <= 120) {
                      onLimitsChange({ ...limits, idleMs: parsed * 1000 });
                    }
                  }}
                  className={cn(
                    'h-6 w-14 rounded border border-input bg-background px-1.5 text-center text-xs tabular-nums',
                    'focus:outline-none focus:ring-1 focus:ring-ring',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] text-muted-foreground">最大询问次数</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={limits.maxContinue}
                  disabled={configLocked}
                  onChange={(e) => {
                    const parsed = parseInt(e.target.value, 10);
                    if (!isNaN(parsed) && parsed >= 1 && parsed <= 20) {
                      onLimitsChange({ ...limits, maxContinue: parsed });
                    }
                  }}
                  className={cn(
                    'h-6 w-14 rounded border border-input bg-background px-1.5 text-center text-xs tabular-nums',
                    'focus:outline-none focus:ring-1 focus:ring-ring',
                    'disabled:cursor-not-allowed disabled:opacity-50',
                  )}
                />
              </div>

              {/* Stages section */}
              <div className="pt-1 border-t border-border/40">
                <div className="flex items-center justify-between pb-2">
                  <span className="text-[11px] font-semibold text-foreground">配置环节</span>
                  <span className="text-[9px] text-muted-foreground/60">任务完成后自动推进</span>
                </div>

                <div className="space-y-2.5">
                  {/* Review-fix loop */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <label
                        htmlFor="shell-autopilot-reviewfix"
                        className={cn('text-xs font-medium leading-none', stagesDisabled ? 'text-muted-foreground/50' : 'text-foreground')}
                      >
                        循环代码评审 + 修复
                      </label>
                      <span className="text-[10px] text-muted-foreground leading-tight">任务完成后评审代码，发现问题自动修复，直到无问题</span>
                    </div>
                    <Switch
                      id="shell-autopilot-reviewfix"
                      checked={toggles.reviewFix}
                      disabled={stagesDisabled}
                      onChange={() => onTogglesChange({ ...toggles, reviewFix: !toggles.reviewFix })}
                      colorOn="bg-purple-600"
                      colorOnBorder="border-purple-700"
                    />
                  </div>

                  {toggles.reviewFix && (
                    <div className="flex items-center justify-between gap-2 pl-4">
                      <span className="text-[10px] text-muted-foreground">最大评审修复次数</span>
                      <input
                        type="number"
                        min={1}
                        max={20}
                        value={limits.maxReviewFix}
                        disabled={stagesDisabled}
                        onChange={(e) => {
                          const parsed = parseInt(e.target.value, 10);
                          if (!isNaN(parsed) && parsed >= 1 && parsed <= 20) {
                            onLimitsChange({ ...limits, maxReviewFix: parsed });
                          }
                        }}
                        className={cn(
                          'h-6 w-14 rounded border border-input bg-background px-1.5 text-center text-xs tabular-nums',
                          'focus:outline-none focus:ring-1 focus:ring-ring',
                          'disabled:cursor-not-allowed disabled:opacity-50',
                        )}
                      />
                    </div>
                  )}

                  {/* Commit no-push */}
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col gap-0.5">
                      <label
                        htmlFor="shell-autopilot-commit"
                        className={cn('text-xs font-medium leading-none', stagesDisabled ? 'text-muted-foreground/50' : 'text-foreground')}
                      >
                        提交（不 push）
                      </label>
                      <span className="text-[10px] text-muted-foreground leading-tight">环节完成后自动 git commit，不会 push 到远程</span>
                    </div>
                    <Switch
                      id="shell-autopilot-commit"
                      checked={toggles.commit}
                      disabled={stagesDisabled}
                      onChange={() => onTogglesChange({ ...toggles, commit: !toggles.commit })}
                      colorOn="bg-cyan-600"
                      colorOnBorder="border-cyan-700"
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
