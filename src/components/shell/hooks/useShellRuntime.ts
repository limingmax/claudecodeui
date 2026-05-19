import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { FitAddon } from '@xterm/addon-fit';
import type { Terminal } from '@xterm/xterm';
import type { UseShellRuntimeOptions, UseShellRuntimeResult } from '../types/types';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { useShellConnection } from './useShellConnection';
import { useShellTerminal } from './useShellTerminal';
import { sendSocketMessage } from '../utils/socket';

export interface ShellAutopilotRuntimeState {
  state: string;
  continueCount: number;
  reviewFixCount: number;
}

export interface UseShellRuntimeExtras {
  autopilotRuntimeState: ShellAutopilotRuntimeState;
  autopilotRef: React.MutableRefObject<{
    execution: boolean;
    reviewFix: boolean;
    commit: boolean;
    idleMs: number;
    maxContinue: number;
    maxReviewFix: number;
  } | null>;
  sendAutopilotAbort: () => void;
  sendAutopilotAttach: (opts: {
    idleMs: number;
    maxContinue: number;
    maxReviewFix: number;
    reviewFix: boolean;
    commit: boolean;
  }) => void;
}

export function useShellRuntime({
  selectedProject,
  selectedSession,
  initialCommand,
  isPlainShell,
  minimal,
  autoConnect,
  isRestarting,
  onProcessComplete,
  onOutputRef,
}: UseShellRuntimeOptions): UseShellRuntimeResult & UseShellRuntimeExtras {
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const [authUrl, setAuthUrl] = useState('');
  const [authUrlVersion, setAuthUrlVersion] = useState(0);

  const selectedProjectRef = useRef(selectedProject);
  const selectedSessionRef = useRef(selectedSession);
  const initialCommandRef = useRef(initialCommand);
  const isPlainShellRef = useRef(isPlainShell);
  const onProcessCompleteRef = useRef(onProcessComplete);
  const authUrlRef = useRef('');
  const lastSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);

  // Keep mutable values in refs so websocket handlers always read current data.
  useEffect(() => {
    selectedProjectRef.current = selectedProject;
    selectedSessionRef.current = selectedSession;
    initialCommandRef.current = initialCommand;
    isPlainShellRef.current = isPlainShell;
    onProcessCompleteRef.current = onProcessComplete;
  }, [selectedProject, selectedSession, initialCommand, isPlainShell, onProcessComplete]);

  const setCurrentAuthUrl = useCallback((nextAuthUrl: string) => {
    authUrlRef.current = nextAuthUrl;
    setAuthUrl(nextAuthUrl);
    setAuthUrlVersion((previous) => previous + 1);
  }, []);

  const closeSocket = useCallback(() => {
    const activeSocket = wsRef.current;
    if (!activeSocket) {
      return;
    }

    if (
      activeSocket.readyState === WebSocket.OPEN ||
      activeSocket.readyState === WebSocket.CONNECTING
    ) {
      activeSocket.close();
    }

    wsRef.current = null;
  }, []);

  const openAuthUrlInBrowser = useCallback((url = authUrlRef.current) => {
    if (!url) {
      return false;
    }

    const popup = window.open(url, '_blank');
    if (popup) {
      try {
        popup.opener = null;
      } catch {
        // Ignore cross-origin restrictions when trying to null opener.
      }
      return true;
    }

    return false;
  }, []);

  const copyAuthUrlToClipboard = useCallback(async (url = authUrlRef.current) => {
    if (!url) {
      return false;
    }

    return copyTextToClipboard(url);
  }, []);

  const { isInitialized, clearTerminalScreen, disposeTerminal } = useShellTerminal({
    terminalContainerRef,
    terminalRef,
    fitAddonRef,
    wsRef,
    selectedProject,
    minimal,
    isRestarting,
    initialCommandRef,
    isPlainShellRef,
    authUrlRef,
    copyAuthUrlToClipboard,
    closeSocket,
  });

  const autopilotRef = useRef<{
    execution: boolean;
    reviewFix: boolean;
    commit: boolean;
    idleMs: number;
    maxContinue: number;
    maxReviewFix: number;
  } | null>(null);
  const [autopilotRuntimeState, setAutopilotRuntimeState] = useState<ShellAutopilotRuntimeState>({ state: 'IDLE', continueCount: 0, reviewFixCount: 0 });

  const onAutopilotEvent = useCallback((payload: Record<string, unknown>) => {
    const kind = payload.kind as string;
    if (kind === 'autopilot.state_changed') {
      const counters = payload.counters as { continue: number; reviewFix: number } | undefined;
      setAutopilotRuntimeState({
        state: payload.to as string,
        continueCount: counters?.continue ?? 0,
        reviewFixCount: counters?.reviewFix ?? 0,
      });
    }
  }, []);

  const sendAutopilotAbort = useCallback(() => {
    sendSocketMessage(wsRef.current, { type: 'autopilot-abort' });
  }, [wsRef]);

  const sendAutopilotAttach = useCallback((opts: {
    idleMs: number;
    maxContinue: number;
    maxReviewFix: number;
    reviewFix: boolean;
    commit: boolean;
  }) => {
    sendSocketMessage(wsRef.current, { type: 'autopilot-attach', ...opts });
  }, [wsRef]);

  const { isConnected, isConnecting, connectToShell, disconnectFromShell } = useShellConnection({
    wsRef,
    terminalRef,
    fitAddonRef,
    selectedProjectRef,
    selectedSessionRef,
    initialCommandRef,
    isPlainShellRef,
    onProcessCompleteRef,
    isInitialized,
    autoConnect,
    closeSocket,
    clearTerminalScreen,
    setAuthUrl: setCurrentAuthUrl,
    onOutputRef,
    autopilotRef,
    onAutopilotEvent,
  });

  useEffect(() => {
    if (!isRestarting) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, isRestarting]);

  useEffect(() => {
    if (selectedProject) {
      return;
    }

    disconnectFromShell();
    disposeTerminal();
  }, [disconnectFromShell, disposeTerminal, selectedProject]);

  useEffect(() => {
    const currentSessionId = selectedSession?.id ?? null;
    if (lastSessionIdRef.current !== currentSessionId && isInitialized) {
      disconnectFromShell();
    }

    lastSessionIdRef.current = currentSessionId;
  }, [disconnectFromShell, isInitialized, selectedSession?.id]);

  return {
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
  };
}
