import React, { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, BotIcon, AlertCircleIcon } from 'lucide-react';
import { cn } from '../../../../lib/utils';
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from '../../../../shared/view/ui/Collapsible';
import type {
  AutopilotPhase,
  AutopilotCounters,
  AutopilotLimits,
  AutopilotToggles,
  AutopilotPendingPermission,
} from '../../hooks/useAutopilotState';

export interface AutopilotPanelProps {
  state: AutopilotPhase | 'IDLE';
  counters: AutopilotCounters;
  limits: AutopilotLimits;
  toggles: AutopilotToggles;
  pendingPermission?: AutopilotPendingPermission;
  onTogglesChange: (next: AutopilotToggles) => void;
  onLimitsChange: (next: AutopilotLimits) => void;
  disabled?: boolean;
}

const STATE_COLORS: Record<string, string> = {
  IDLE: 'text-muted-foreground',
  EXECUTING: 'text-blue-500',
  COMPLETION_PROBE: 'text-yellow-500',
  REVIEWING: 'text-purple-500',
  FIXING: 'text-orange-500',
  COMMITTING: 'text-cyan-500',
  DONE: 'text-emerald-500',
  FAILED: 'text-destructive',
  CANCELLED: 'text-muted-foreground',
};

const STATE_DOT_COLORS: Record<string, string> = {
  IDLE: 'bg-muted-foreground/40',
  EXECUTING: 'bg-blue-500',
  COMPLETION_PROBE: 'bg-yellow-500',
  REVIEWING: 'bg-purple-500',
  FIXING: 'bg-orange-500',
  COMMITTING: 'bg-cyan-500',
  DONE: 'bg-emerald-500',
  FAILED: 'bg-destructive',
  CANCELLED: 'bg-muted-foreground/40',
};

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id: string;
  label: string;
  hint?: string;
}

function ToggleSwitch({ checked, onChange, disabled, id, label, hint }: ToggleSwitchProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="flex flex-col gap-0.5">
        <label
          htmlFor={id}
          className={cn(
            'text-xs font-medium leading-none',
            disabled ? 'text-muted-foreground/50' : 'text-foreground',
          )}
        >
          {label}
        </label>
        {hint && (
          <span className="text-[10px] text-muted-foreground leading-tight">{hint}</span>
        )}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400 disabled:cursor-not-allowed disabled:opacity-50',
          checked
            ? 'bg-blue-600 border-blue-700'
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
    </div>
  );
}

interface LimitInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
}

function LimitInput({ label, value, onChange, disabled, min = 1, max = 20 }: LimitInputProps) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          const parsed = parseInt(e.target.value, 10);
          if (!isNaN(parsed) && parsed >= min && parsed <= max) {
            onChange(parsed);
          }
        }}
        className={cn(
          'h-6 w-14 rounded border border-input bg-background px-1.5 text-center text-xs tabular-nums',
          'focus:outline-none focus:ring-1 focus:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      />
    </div>
  );
}

export default function AutopilotPanel({
  state,
  counters,
  limits,
  toggles,
  pendingPermission,
  onTogglesChange,
  onLimitsChange,
  disabled = false,
}: AutopilotPanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const isActive = state !== 'IDLE';
  const effectiveDisabled = disabled || isActive;

  const dotColor = STATE_DOT_COLORS[state] ?? STATE_DOT_COLORS.IDLE;
  const stateColor = STATE_COLORS[state] ?? STATE_COLORS.IDLE;

  return (
    <Collapsible defaultOpen={false} className="mb-2 rounded-lg border border-border/60 bg-muted/30">
      <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-muted/50 transition-colors rounded-lg">
        <div className="flex items-center gap-2">
          <BotIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Autopilot 阶段托管</span>
          {isActive && (
            <span className={cn('flex items-center gap-1 text-[10px] font-medium', stateColor)}>
              <span className={cn('h-1.5 w-1.5 rounded-full animate-pulse', dotColor)} />
              {state}
            </span>
          )}
        </div>
        <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground transition-transform [[data-state=open]_&]:rotate-90" />
      </CollapsibleTrigger>

      <CollapsibleContent>
        <div className="px-3 pb-3 pt-1 space-y-3">
          {/* Status row */}
          {isActive && (
            <div className="rounded-md border border-border/50 bg-background/60 px-2.5 py-2 space-y-1.5">
              <div className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', dotColor)} />
                <span className={cn('text-xs font-semibold', stateColor)}>{state}</span>
              </div>
              <div className="text-[10px] text-muted-foreground tabular-nums">
                续传 {counters.continue}/{limits.maxContinue}
                {' · '}
                评审修复 {counters.reviewFix}/{limits.maxReviewFix}
                {' · '}
                网络重试 {counters.networkRetry}/{limits.maxNetworkRetry}
              </div>
            </div>
          )}

          {/* Pending permission warning */}
          {pendingPermission && (
            <div className="flex items-start gap-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-2.5 py-2">
              <AlertCircleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-yellow-500" />
              <div className="text-[10px] text-yellow-600 dark:text-yellow-400">
                <span className="font-medium">等待审批：</span>
                <code className="rounded bg-yellow-500/20 px-1 py-0.5 text-[10px]">
                  {pendingPermission.tool}
                </code>
                <span className="ml-1 text-muted-foreground">
                  — 请在上方权限请求中处理
                </span>
              </div>
            </div>
          )}

          {/* Toggle switches */}
          <div className="space-y-2.5">
            <ToggleSwitch
              id="autopilot-execution"
              label="执行续传"
              hint="任务未完成时自动继续执行"
              checked={toggles.execution}
              onChange={(v) => onTogglesChange({ ...toggles, execution: v })}
              disabled={effectiveDisabled}
            />
            <ToggleSwitch
              id="autopilot-review-fix"
              label="评审-修复闭环"
              hint="执行完成后自动触发代码评审并修复"
              checked={toggles.reviewFix}
              onChange={(v) => onTogglesChange({ ...toggles, reviewFix: v })}
              disabled={effectiveDisabled}
            />
            <ToggleSwitch
              id="autopilot-commit"
              label="自动提交"
              hint="开启后将自动提交（不 push），覆盖默认规则"
              checked={toggles.commit}
              onChange={(v) => onTogglesChange({ ...toggles, commit: v })}
              disabled={effectiveDisabled}
            />
          </div>

          {/* Advanced limits */}
          <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
              {advancedOpen ? (
                <ChevronDownIcon className="h-3 w-3" />
              ) : (
                <ChevronRightIcon className="h-3 w-3" />
              )}
              高级设置
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-2 space-y-1.5 rounded-md border border-border/40 bg-background/40 px-2.5 py-2">
                <LimitInput
                  label="最大续传次数"
                  value={limits.maxContinue}
                  onChange={(v) => onLimitsChange({ ...limits, maxContinue: v })}
                  disabled={effectiveDisabled}
                />
                <LimitInput
                  label="最大评审修复次数"
                  value={limits.maxReviewFix}
                  onChange={(v) => onLimitsChange({ ...limits, maxReviewFix: v })}
                  disabled={effectiveDisabled}
                />
                <LimitInput
                  label="最大网络重试次数"
                  value={limits.maxNetworkRetry}
                  onChange={(v) => onLimitsChange({ ...limits, maxNetworkRetry: v })}
                  disabled={effectiveDisabled}
                  max={10}
                />
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
