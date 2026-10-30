export type QrConnectPhase =
  | "idle"
  | "loading"
  | "waiting"
  | "scanned"
  | "confirming"
  | "done"
  | "expired"
  | "error";

export interface QrConnectState<TData = unknown, TSession = unknown> {
  phase: QrConnectPhase;
  session: TSession | null;
  qrContent: string | null;
  error: string | null;
  data: TData | null;
}

export type QrConnectEvent<TData = unknown, TSession = unknown> =
  | { type: "START" }
  | { type: "QR_READY"; session: TSession; qrContent: string }
  | { type: "SCANNED" }
  | { type: "CONFIRMING" }
  | { type: "CONFIRMED"; data: TData }
  | { type: "EXPIRED" }
  | { type: "ERROR"; error: string }
  | { type: "RESET" };

export const MIN_QR_POLL_INTERVAL_MS = 1200;

export function createInitialQrState<TData = unknown, TSession = unknown>(): QrConnectState<TData, TSession> {
  return {
    phase: "idle",
    session: null,
    qrContent: null,
    error: null,
    data: null,
  };
}

export function qrConnectReducer<TData = unknown, TSession = unknown>(
  state: QrConnectState<TData, TSession>,
  event: QrConnectEvent<TData, TSession>,
): QrConnectState<TData, TSession> {
  switch (event.type) {
    case "START":
      return {
        phase: "loading",
        session: null,
        qrContent: null,
        error: null,
        data: null,
      };
    case "QR_READY":
      if (state.phase !== "loading" && state.phase !== "idle") return state;
      return {
        phase: "waiting",
        session: event.session,
        qrContent: event.qrContent,
        error: null,
        data: null,
      };
    case "SCANNED":
      if (state.phase !== "waiting") return state;
      return {
        ...state,
        phase: "scanned",
      };
    case "CONFIRMING":
      if (state.phase !== "scanned" && state.phase !== "waiting") return state;
      return {
        ...state,
        phase: "confirming",
      };
    case "CONFIRMED":
      return {
        ...state,
        phase: "done",
        data: event.data,
      };
    case "EXPIRED":
      if (state.phase === "done") return state;
      return {
        ...state,
        phase: "expired",
      };
    case "ERROR":
      if (state.phase === "done") return state;
      return {
        ...state,
        phase: "error",
        error: event.error,
      };
    case "RESET":
      return createInitialQrState<TData, TSession>();
    default:
      return state;
  }
}
