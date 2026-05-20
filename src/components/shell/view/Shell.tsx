import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@xterm/xterm/css/xterm.css';
import type { Project, ProjectSession } from '../../../types/app';
import {
  PROMPT_BUFFER_SCAN_LINES,
  PROMPT_DEBOUNCE_MS,
  PROMPT_MAX_OPTIONS,
  PROMPT_MIN_OPTIONS,
  PROMPT_OPTION_SCAN_LINES,
  SHELL_RESTART_DELAY_MS,
} from '../constants/constants';
import { useShellRuntime } from '../hooks/useShellRuntime';
import { sendSocketMessage } from '../utils/socket';
import { getSessionDisplayName } from '../utils/auth';
import ShellConnectionOverlay from './subcomponents/ShellConnectionOverlay';
import ShellEmptyState from './subcomponents/ShellEmptyState';
import ShellHeader from './subcomponents/ShellHeader';
import ShellMinimalView from './subcomponents/ShellMinimalView';
import TerminalShortcutsPanel from './subcomponents/TerminalShortcutsPanel';
import ShellAutopilotPanel from './subcomponents/ShellAutopilotPanel';
import type { ShellAutopilotToggles, ShellAutopilotLimits } from './subcomponents/ShellAutopilotPanel';

type CliPromptOption = { number: string; label: string };

type ShellProps = {
  selectedProject?: Project | null;
  selectedSession?: ProjectSession | null;
  initialCommand?: string | null;
  isPlainShell?: boolean;
  onProcessComplete?: ((exitCode: number) => void) | null;
  minimal?: boolean;
  autoConnect?: boolean;
  isActive?: boolean;
};

export default function Shell({
  selectedProject = null,
  selectedSession = null,
  initialCommand = null,
  isPlainShell = false,
  onProcessComplete = null,
  minimal = false,
  autoConnect = false,
  isActive = true,
}: ShellProps) {
  const { t } = useTranslation('chat');
  const [isRestarting, setIsRestarting] = useState(false);
  const [cliPromptOptions, setCliPromptOptions] = useState<CliPromptOption[] | null>(null);
  const promptCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onOutputRef = useRef<(() => void) | null>(null);

  const {
    terminalContainerRef,
    terminalRef,
    wsRef,
    isConnected,
    isInitialized,
    isConnecting,
    authUrl,
    authUrlVersion,
    connectToShell,
    disconnectFromShell,
    openAuthUrlInBrowser,
    copyAuthUrlToClipboard,
    autopilotRuntimeState,
    autopilotRef,
    sendAutopilotAbort,
    sendAutopilotAttach,
  } = useShellRuntime({
    selectedProject,
    selectedSession,
    initialCommand,
    isPlainShell,
    minimal,
    autoConnect,
    isRestarting,
    onProcessComplete,
    onOutputRef,
  });

  const [autopilotToggles, setAutopilotToggles] = useState<ShellAutopilotToggles>({ execution: false, reviewFix: false, commit: false });
  const [autopilotLimits, setAutopilotLimits] = useState<ShellAutopilotLimits>({ idleMs: 10000, maxContinue: 5, maxReviewFix: 5 });

  useEffect(() => {
    autopilotRef.current = {
      execution: autopilotToggles.execution,
      reviewFix: autopilotToggles.reviewFix,
      commit: autopilotToggles.commit,
      idleMs: autopilotLimits.idleMs,
      maxContinue: autopilotLimits.maxContinue,
      maxReviewFix: autopilotLimits.maxReviewFix,
    };
  }, [autopilotRef, autopilotToggles.execution, autopilotToggles.reviewFix, autopilotToggles.commit, autopilotLimits.idleMs, autopilotLimits.maxContinue, autopilotLimits.maxReviewFix]);

  // Hot-attach/detach driver when toggle flips while connected.
  //
  // Initial attach on connect is handled by the `init` message (sent in
  // useShellConnection.onopen, which includes the autopilot config from
  // autopilotRef). This effect handles 3 cases after the connection is live:
  //   1. Master switch OFF → ON: send autopilot-attach with current config
  //   2. Master switch ON → OFF: send autopilot-abort
  //   3. While master is ON, reviewFix/commit toggles change: re-attach
  //      with the new config so the server-side driver picks them up
  //      mid-session (otherwise the toggles only take effect on the next
  //      OFF→ON cycle, which the user found surprising).
  const prevExecutionRef = useRef(autopilotToggles.execution);
  const prevReviewFixRef = useRef(autopilotToggles.reviewFix);
  const prevCommitRef = useRef(autopilotToggles.commit);
  const prevConnectedRef = useRef(false);
  useEffect(() => {
    if (!isConnected) {
      prevConnectedRef.current = false;
      prevExecutionRef.current = autopilotToggles.execution;
      prevReviewFixRef.current = autopilotToggles.reviewFix;
      prevCommitRef.current = autopilotToggles.commit;
      return;
    }

    const justConnected = !prevConnectedRef.current;
    prevConnectedRef.current = true;

    if (justConnected) {
      prevExecutionRef.current = autopilotToggles.execution;
      prevReviewFixRef.current = autopilotToggles.reviewFix;
      prevCommitRef.current = autopilotToggles.commit;
      return;
    }

    const prev = prevExecutionRef.current;
    const next = autopilotToggles.execution;
    const stageChanged =
      prevReviewFixRef.current !== autopilotToggles.reviewFix ||
      prevCommitRef.current !== autopilotToggles.commit;

    if (prev !== next) {
      console.log('[shell-autopilot] master toggle change', { prev, next, idleMs: autopilotLimits.idleMs });
      if (next) {
        console.log('[shell-autopilot] sending autopilot-attach (master ON)');
        sendAutopilotAttach({
          idleMs: autopilotLimits.idleMs,
          maxContinue: autopilotLimits.maxContinue,
          maxReviewFix: autopilotLimits.maxReviewFix,
          reviewFix: autopilotToggles.reviewFix,
          commit: autopilotToggles.commit,
        });
      } else {
        console.log('[shell-autopilot] sending autopilot-abort (master OFF)');
        sendAutopilotAbort();
      }
      prevExecutionRef.current = next;
    } else if (next && stageChanged) {
      // Master still ON, but a stage toggle changed → re-attach so the new
      // config takes effect immediately. Server tears down the old driver.
      console.log('[shell-autopilot] stage toggle change → re-attach', {
        reviewFix: autopilotToggles.reviewFix,
        commit: autopilotToggles.commit,
      });
      sendAutopilotAttach({
        idleMs: autopilotLimits.idleMs,
        maxContinue: autopilotLimits.maxContinue,
        maxReviewFix: autopilotLimits.maxReviewFix,
        reviewFix: autopilotToggles.reviewFix,
        commit: autopilotToggles.commit,
      });
    }

    prevReviewFixRef.current = autopilotToggles.reviewFix;
    prevCommitRef.current = autopilotToggles.commit;
  }, [autopilotToggles.execution, autopilotToggles.reviewFix, autopilotToggles.commit, autopilotLimits.idleMs, autopilotLimits.maxContinue, autopilotLimits.maxReviewFix, isConnected, sendAutopilotAttach, sendAutopilotAbort]);

  const handleAutopilotAbort = useCallback(() => {
    sendAutopilotAbort();
  }, [sendAutopilotAbort]);

  // Check xterm.js buffer for CLI prompt patterns (❯ N. label)
  const checkBufferForPrompt = useCallback(() => {
    const term = terminalRef.current;
    if (!term) return;
    const buf = term.buffer.active;
    const lastContentRow = buf.baseY + buf.cursorY;
    const scanEnd = Math.min(buf.baseY + buf.length - 1, lastContentRow + 10);
    const scanStart = Math.max(0, lastContentRow - PROMPT_BUFFER_SCAN_LINES);
    const lines: string[] = [];
    for (let i = scanStart; i <= scanEnd; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString().trimEnd());
    }

    let footerIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/esc to cancel/i.test(lines[i]) || /enter to select/i.test(lines[i])) {
        footerIdx = i;
        break;
      }
    }

    if (footerIdx === -1) {
      setCliPromptOptions(null);
      return;
    }

    // Scan upward from footer collecting numbered options.
    // Non-matching lines are allowed (multi-line labels, blank separators)
    // because CLI prompts may wrap options across multiple terminal rows.
    const optMap = new Map<string, string>();
    const optScanStart = Math.max(0, footerIdx - PROMPT_OPTION_SCAN_LINES);
    for (let i = footerIdx - 1; i >= optScanStart; i--) {
      const match = lines[i].match(/^\s*[❯›>]?\s*(\d+)\.\s+(.+)/);
      if (match) {
        const num = match[1];
        const label = match[2].trim();
        if (parseInt(num, 10) <= PROMPT_MAX_OPTIONS && label.length > 0 && !optMap.has(num)) {
          optMap.set(num, label);
        }
      }
    }

    const valid: CliPromptOption[] = [];
    for (let i = 1; i <= optMap.size; i++) {
      if (optMap.has(String(i))) valid.push({ number: String(i), label: optMap.get(String(i))! });
      else break;
    }

    setCliPromptOptions(valid.length >= PROMPT_MIN_OPTIONS ? valid : null);
  }, [terminalRef]);

  // Schedule prompt check after terminal output (debounced)
  const schedulePromptCheck = useCallback(() => {
    if (promptCheckTimer.current) clearTimeout(promptCheckTimer.current);
    promptCheckTimer.current = setTimeout(checkBufferForPrompt, PROMPT_DEBOUNCE_MS);
  }, [checkBufferForPrompt]);

  // Wire up the onOutput callback
  useEffect(() => {
    onOutputRef.current = schedulePromptCheck;
  }, [schedulePromptCheck]);

  // Cleanup prompt check timer on unmount
  useEffect(() => {
    return () => {
      if (promptCheckTimer.current) clearTimeout(promptCheckTimer.current);
    };
  }, []);

  // Clear stale prompt options and cancel pending timer on disconnect
  useEffect(() => {
    if (!isConnected) {
      if (promptCheckTimer.current) {
        clearTimeout(promptCheckTimer.current);
        promptCheckTimer.current = null;
      }
      setCliPromptOptions(null);
    }
  }, [isConnected]);

  useEffect(() => {
    if (!isActive || !isInitialized || !isConnected) {
      return;
    }

    const focusTerminal = () => {
      terminalRef.current?.focus();
    };

    const animationFrameId = window.requestAnimationFrame(focusTerminal);
    const timeoutId = window.setTimeout(focusTerminal, 0);

    return () => {
      window.cancelAnimationFrame(animationFrameId);
      window.clearTimeout(timeoutId);
    };
  }, [isActive, isConnected, isInitialized, terminalRef]);

  const sendInput = useCallback(
    (data: string) => {
      sendSocketMessage(wsRef.current, { type: 'input', data });
    },
    [wsRef],
  );

  const sessionDisplayName = useMemo(() => getSessionDisplayName(selectedSession), [selectedSession]);
  const sessionDisplayNameShort = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 30) : null),
    [sessionDisplayName],
  );
  const sessionDisplayNameLong = useMemo(
    () => (sessionDisplayName ? sessionDisplayName.slice(0, 50) : null),
    [sessionDisplayName],
  );

  const handleRestartShell = useCallback(() => {
    setIsRestarting(true);
    window.setTimeout(() => {
      setIsRestarting(false);
    }, SHELL_RESTART_DELAY_MS);
  }, []);

  if (!selectedProject) {
    return (
      <ShellEmptyState
        title={t('shell.selectProject.title')}
        description={t('shell.selectProject.description')}
      />
    );
  }

  if (minimal) {
    return (
      <>
        <ShellMinimalView
          terminalContainerRef={terminalContainerRef}
          authUrl={authUrl}
          authUrlVersion={authUrlVersion}
          initialCommand={initialCommand}
          isConnected={isConnected}
          openAuthUrlInBrowser={openAuthUrlInBrowser}
          copyAuthUrlToClipboard={copyAuthUrlToClipboard}
        />
        <TerminalShortcutsPanel
          wsRef={wsRef}
          terminalRef={terminalRef}
          isConnected={isConnected}
          bottomOffset="bottom-0"
        />
      </>
    );
  }

  const readyDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: selectedProject.displayName,
      })
    : selectedSession
      ? t('shell.resumeSession', { displayName: sessionDisplayNameLong })
      : t('shell.startSession');

  const connectingDescription = isPlainShell
    ? t('shell.runCommand', {
        command: initialCommand || t('shell.defaultCommand'),
        projectName: selectedProject.displayName,
      })
    : t('shell.startCli', { projectName: selectedProject.displayName });

  const overlayMode = !isInitialized ? 'loading' : isConnecting ? 'connecting' : !isConnected ? 'connect' : null;
  const overlayDescription = overlayMode === 'connecting' ? connectingDescription : readyDescription;

  return (
    <div className="flex h-full w-full flex-col bg-gray-900">
      <ShellHeader
        isConnected={isConnected}
        isInitialized={isInitialized}
        isRestarting={isRestarting}
        hasSession={Boolean(selectedSession)}
        sessionDisplayNameShort={sessionDisplayNameShort}
        onDisconnect={disconnectFromShell}
        onRestart={handleRestartShell}
        statusNewSessionText={t('shell.status.newSession')}
        statusInitializingText={t('shell.status.initializing')}
        statusRestartingText={t('shell.status.restarting')}
        disconnectLabel={t('shell.actions.disconnect')}
        disconnectTitle={t('shell.actions.disconnectTitle')}
        restartLabel={t('shell.actions.restart')}
        restartTitle={t('shell.actions.restartTitle')}
        disableRestart={isRestarting || isConnected}
      />

      <ShellAutopilotPanel
        toggles={autopilotToggles}
        limits={autopilotLimits}
        autopilotState={autopilotRuntimeState}
        onTogglesChange={setAutopilotToggles}
        onLimitsChange={setAutopilotLimits}
        onAbort={handleAutopilotAbort}
        isConnected={isConnected}
      />

      <div className="relative flex-1 overflow-hidden p-2">
        <div
          ref={terminalContainerRef}
          className="h-full w-full focus:outline-none"
          style={{ outline: 'none' }}
        />

        {overlayMode && (
          <ShellConnectionOverlay
            mode={overlayMode}
            description={overlayDescription}
            loadingLabel={t('shell.loading')}
            connectLabel={t('shell.actions.connect')}
            connectTitle={t('shell.actions.connectTitle')}
            connectingLabel={t('shell.connecting')}
            onConnect={connectToShell}
          />
        )}

        {cliPromptOptions && isConnected && (
          <div
            className="absolute inset-x-0 bottom-0 z-10 border-t border-gray-700/80 bg-gray-800/95 px-3 py-2 backdrop-blur-sm"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex flex-wrap items-center gap-2">
              {cliPromptOptions.map((opt) => (
                <button
                  type="button"
                  key={opt.number}
                  onClick={() => {
                    sendInput(opt.number);
                    setCliPromptOptions(null);
                  }}
                  className="max-w-36 truncate rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700"
                  title={`${opt.number}. ${opt.label}`}
                >
                  {opt.number}. {opt.label}
                </button>
              ))}
              <button
                type="button"
                onClick={() => {
                  sendInput('\x1b');
                  setCliPromptOptions(null);
                }}
                className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 transition-colors hover:bg-gray-600"
              >
                Esc
              </button>
            </div>
          </div>
        )}
      </div>

      <TerminalShortcutsPanel
        wsRef={wsRef}
        terminalRef={terminalRef}
        isConnected={isConnected}
      />

    </div>
  );
}
