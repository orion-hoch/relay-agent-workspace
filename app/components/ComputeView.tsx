import "./compute-setup.css";
import { ComputeHomesView, type ComputeHomeMetrics } from "./ComputeHomesView";
import { AgentsView } from "./AgentsView";
import { useEffect, useRef, useState } from "react";
import { Check, Download } from "lucide-react";


type Phase = "not_installed" | "downloading" | "installing" | "starting" | "ready" | "error";
type SetupStatus = {
  phase: Phase;
  model: string;
  progress?: number;
  message?: string;
  error?: string;
  downloaded?: number;
  total?: number;
  logs?: string[];
  metrics?: ComputeHomeMetrics | null;
};
const labels: Record<Phase, string> = {
  not_installed: "Not installed",
  downloading: "Downloading",
  installing: "Preparing",
  starting: "Starting",
  ready: "Ready",
  error: "Setup failed",
};
const activePhases: Phase[] = ["downloading", "installing", "starting"];
function readMetrics(value: unknown): ComputeHomeMetrics | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (typeof data.measuredAt !== "string" || !Number.isFinite(Date.parse(data.measuredAt))
    || Date.now() - Date.parse(data.measuredAt) > 30000
    || typeof data.ramUsedBytes !== "number" || !Number.isFinite(data.ramUsedBytes) || data.ramUsedBytes < 0
    || typeof data.ramTotalBytes !== "number" || !Number.isFinite(data.ramTotalBytes) || data.ramTotalBytes <= 0) return null;
  const percent = (item: unknown) => typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 100 ? item : null;
  return {
    cpuPercent: percent(data.cpuPercent), gpuPercent: percent(data.gpuPercent),
    ramUsedBytes: data.ramUsedBytes, ramTotalBytes: data.ramTotalBytes, measuredAt: data.measuredAt,
  };
}
function readStatus(value: unknown): SetupStatus {
  if (!value || typeof value !== "object") throw new Error("Setup status unavailable.");
  const data = value as Record<string, unknown>;
  if (
    typeof data.phase !== "string" ||
    !Object.prototype.hasOwnProperty.call(labels, data.phase) ||
    typeof data.model !== "string"
  )
    throw new Error("Setup status unavailable.");
  const finite = (item: unknown): item is number =>
    typeof item === "number" && Number.isFinite(item) && item >= 0;
  return {
    phase: data.phase as Phase,
    model: data.model,
    metrics: readMetrics(data.metrics),
    progress: finite(data.progress) ? Math.min(100, data.progress) : undefined,
    message: typeof data.message === "string" ? data.message : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
    downloaded: finite(data.downloaded) ? data.downloaded : undefined,
    total: finite(data.total) ? data.total : undefined,
    logs: Array.isArray(data.logs)
      ? data.logs.filter((line): line is string => typeof line === "string").slice(-100)
      : undefined,
  };
}
async function requestStatus(method: "GET" | "POST", signal: AbortSignal): Promise<SetupStatus> {
  const response = await fetch("/api/compute/setup", {
    method,
    signal,
    credentials: "same-origin",
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data && typeof data === "object" && "error" in data ? data.error : null;
    throw new Error(
      typeof error === "string" ? error : `Setup service returned ${response.status}.`,
    );
  }
  return readStatus(data);
}
function bytes(value: number) {
  return value < 1e9 ? `${(value / 1e6).toFixed(0)} MB` : `${(value / 1e9).toFixed(1)} GB`;
}

export function ComputeView({ onNotify }: { onNotify?: (message: string) => void }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [connectionError, setConnectionError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (stopped) return;
      if (submittingRef.current) {
        timer = setTimeout(poll, 2500);
        return;
      }
      const controller = new AbortController();
      readController.current = controller;
      const currentRevision = revision.current;
      let delay = 2500;
      try {
        const next = await requestStatus("GET", controller.signal);
        if (stopped || revision.current !== currentRevision) return;
        setStatus(next);
        setConnectionError("");
        if (next.phase === "ready") delay = 5000;
      } catch (error) {
        if (!stopped && !controller.signal.aborted && revision.current === currentRevision)
          setConnectionError(
            error instanceof Error ? error.message : "Unable to reach the setup service.",
          );
      } finally {
        if (!stopped) timer = setTimeout(poll, delay);
      }
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      readController.current?.abort();
      writeController.current?.abort();
    };
  }, []);
  async function setup() {
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    revision.current += 1;
    readController.current?.abort();
    const controller = new AbortController();
    writeController.current = controller;
    try {
      const next = await requestStatus("POST", controller.signal);
      if (controller.signal.aborted) return;
      setStatus(next);
      setConnectionError("");
      if (next.phase === "ready") onNotify?.("Compute is ready.");
    } catch (error) {
      if (!controller.signal.aborted)
        setConnectionError(error instanceof Error ? error.message : "Unable to start setup.");
    } finally {
      submittingRef.current = false;
      if (!controller.signal.aborted) setSubmitting(false);
    }
  }
  const active = !!status && activePhases.includes(status.phase) && !connectionError;
  const ready = status?.phase === "ready" && !connectionError;
  const progress =
    status?.progress ??
    (status?.total && status.downloaded !== undefined
      ? Math.min(100, (status.downloaded / status.total) * 100)
      : undefined);
  const phaseLabel = connectionError
    ? "Not connected"
    : submitting
      ? "Starting setup"
      : status
        ? labels[status.phase]
        : "Checking connection";
  const error = connectionError || status?.error;
  const buttonText = ready
    ? "Ready"
    : submitting
      ? "Starting setup…"
      : active
        ? `${labels[status.phase]}…`
        : connectionError || status?.phase === "error"
          ? "Retry setup"
          : "Download and set up";
  return <AgentsView onNotify={onNotify} renderHomes={(groups) => <ComputeHomesView
    {...groups}
    metrics={connectionError ? null : readMetrics(status?.metrics)}
    localStatus={<output aria-live="polite">{ready && <Check size={14} />} {phaseLabel}</output>}
    cloudStatus="Not connected"
    localActions={!ready ? <button className="btn btn-primary" disabled={submitting || active} onClick={() => void setup()}><Download size={16} /> {buttonText}</button> : undefined}
    localSetup={active || error || status?.logs?.length ? <>
        {active && (
          <div className="compute-setup-progress">
            <progress aria-label="Setup progress" max={100} value={progress} />
            <div>
              <span>{status?.message || phaseLabel}</span>
              <span>{progress !== undefined ? `${Math.round(progress)}%` : ""}</span>
            </div>
            {status?.downloaded !== undefined && status.total !== undefined && (
              <small>
                {bytes(status.downloaded)} / {bytes(status.total)}
              </small>
            )}
          </div>
        )}
        {error && (
          <p className="compute-setup-error" role="alert">
            {error}
          </p>
        )}
        {Boolean(status?.logs?.length) && (
          <details className="compute-setup-logs">
            <summary>Details</summary>
            <pre>{status?.logs?.join("\n")}</pre>
          </details>
        )}
    </> : undefined}
  />} />;
}
